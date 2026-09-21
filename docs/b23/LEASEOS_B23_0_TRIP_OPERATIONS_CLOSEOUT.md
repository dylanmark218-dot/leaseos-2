# LeaseOS v23.25 — Trip operations closeout

Release state: **UNRELEASED — engines only.** Four pure modules and their Vitest
coverage land here. Nothing is wired to a router, nothing touches the schema, and
no migration is included. Wiring is the next commit and is described at the end.

Repository audited at `LEASEOS_RELEASE` **v23.24** — 408 tables, 583 server
modules, 164 migrations.

---

## What the audit found

`todo.md` is stale. Two of its three open sections are substantially built and
were never ticked:

| todo section | Actual state |
|---|---|
| **Disposal directory refinement** (5 open items) | Built. `facilities`, `facilityCapabilities`, `facilityEvidence`, `facilityOperatingHours`, `facilityCallAheads`, `facilityWaitReports`, `facilityAliases`, `facilitySourceLicences`, `facilityImportRuns`, `loadFacilityAssessments` all exist, with `facilityDirectoryRouter.ts` and `facilityDirectory.db.test.ts`. Verification status, confidence, provenance and licence keys are first-class. |
| **Jurisdiction-aware HOS expansion** (10 open items) | Built as rules-as-data. `hosRuleProfiles`, `hosRuleLimits`, `hosRuleLimitHistory`, `hosAttestations`, `dutyRecords`, plus `hos.ts`, `hosRouter.ts`, `hosAttestation.test.ts`, `jurisdiction.test.ts`. The remaining work is **P9 verification** — every seeded figure reads UNKNOWN until a person verifies it against its clause, which `LEASEOS_CURRENT_STATE.md` correctly records as blocked on a human, not on code. |
| **Trip operations / six-month field refinement** (8 open items) | Genuinely mixed — see below. |

Also already built, despite reading as open:

- **Pre-trip critical-defect dispatch block and mechanic release** — `dispatchEnforcementService.ts` gates on `criticalDefectCount` and `mechanicReleaseVersion`; `dispatchEnforcement.test.ts` proves a defect moves a legacy assignment.
- **Operator document expiry engine** — `complianceDocumentValidity.ts` (`complianceDocumentValidity`, `documentExpiry`), over `qualificationTypes` / `workerQualifications` / `trainingRecords`, with `documentValidity.test.ts`.

### Genuinely missing — now written

| Gap | New module |
|---|---|
| Site-specific baseline statistics and alerts for unusually long setup/load/unload times | `server/_core/siteBaseline.ts` |
| Automatic billing line generation from verified trip distance, billable time, disposal tickets and approved rate cards | `server/_core/tripBillingProjection.ts` |
| Automatic manifest / trip passport package generation after completed round trips | `server/_core/tripPassportPackage.ts` |
| Digital safety binder completeness score per unit with office task queue | `server/_core/safetyBinder.ts` |

### Not code

The last two todo items — the six-month pilot with driver interviews, and
versioning every workflow change so feedback traces to a product decision — are
process, not build. They belong in a pilot plan, not a sprint.

---

## The four modules

All four are pure functions: no database, no clock of their own, no I/O. Each
takes facts and a `now`, and returns a verdict plus the specific named gaps.
They follow the invariant the rest of the codebase already holds — **unknown
never renders as safe**.

### `siteBaseline.ts`

Robust per-site statistics for setup, operation, wait and total time, and an
assessment of one stop against them.

- **Median and MAD, not mean and standard deviation.** Oilfield stop durations
  are small-n and right-skewed; one freeze-off would drag a mean baseline
  permanently upward.
- **Eight confirmed samples minimum** (`MINIMUM_SAMPLES`). Below that the verdict
  is `insufficient_history`, never `within_baseline`. A four-hour stop at an
  unmeasured site is reported as unmeasured.
- **Unconfirmed timings are excluded outright**, not down-weighted — a baseline
  built from GPS proposals would launder inference into a standard. The excluded
  count is reported so nobody wonders where the samples went.
- Alerts name the observation and the comparison, never a cause. A test asserts
  no alert text contains "customer", "driver", "because" or "caused".
- `MAD === 0` (every sample identical) falls back to a multiple-of-median rule
  rather than dividing by zero, and the `math` string says which rule ran.

### `tripBillingProjection.ts`

The missing step *before* `billing.ts`. `calculateChargeLines` already owns the
arithmetic and the verified-only rule; nothing built its `ChargeLineSource[]`
from a trip. This does, and only that — it prices nothing and posts nothing.

- Imports `ChargeLineSource` from `./billing` and feeds it unchanged. A test
  runs the output straight through `calculateChargeLines` and checks the subtotal.
- **Odometer beats GPS.** An odometer pair confirmed by a person is `verified`;
  a GPS-derived distance is carried with `verified: false` so the existing
  `excluded` path drops it, and an omission says what would fix it.
- A backwards odometer pair is reported `odometer_implausible`, never absolute-valued.
- **A missing rate is never a zero rate.** No rate card, no effective rate, or
  two rate lines sharing an effective date each produce a named omission. The
  tie is refused rather than broken — otherwise the invoice depends on row order.
- `review_required` time does not bill on its own; unconfirmed stop time is
  excluded from the total.
- Every omission carries a `needs` field: the specific action, because "incomplete"
  is not something an office clerk can act on.

### `tripPassportPackage.ts`

Assembles the package after a round trip closes, and detects when it has gone stale.

- Three verdicts: `sealable`, `incomplete`, `unresolved`. **Unknown applicability
  outranks a missing document** — an unanswered "does this trip need a weight
  record?" is `unresolved`, because quietly classifying it not-applicable is how a
  package comes to certify a trip nobody checked.
- Present-but-unverified blocks exactly as missing does.
- `detectStaleness` compares a built package against current inputs and names
  what moved — reference changed, verification withdrawn, applicability changed.
  **It does not rebuild.** The verdict and hash stay as built; only `status` and
  `staleReasons` change. This matches the existing statement in
  `LEASEOS_CURRENT_STATE.md`: a package is only as current as its last rebuild,
  nothing rebuilds automatically.
- `mayReleaseWithoutAcknowledgement` is the gate: sealable **and** current.

### `safetyBinder.ts`

Per-unit binder completeness plus the office task queue.

- **Unverified is not present.** A photographed licence nobody checked scores the
  same as a missing one, because a roadside inspector counts them the same.
- **The denominator is always shown** — `"7 of 9 required documents verified"`,
  never a bare percentage that hides whether the missing 22% is a spare-key
  receipt or the insurance slip.
- Verified with no recorded expiry is its own status (`expiry_unrecorded`) and
  does not satisfy. A renewal interval is not an expiry date.
- Unknown applicability counts in the denominator and raises an `open_question`
  task; genuinely not-applicable does not count.
- `fleetTaskQueue` orders urgent → soon → open question, then by due date.

---

## Verification

Run against the real repository modules (`billing.ts` imported for real, not stubbed):

```
✓ server/_core/tripBillingProjection.test.ts  (16 tests)
✓ server/_core/safetyBinder.test.ts           (11 tests)
✓ server/_core/tripPassportPackage.test.ts    (12 tests)
✓ server/_core/siteBaseline.test.ts           (13 tests)

Test Files  4 passed (4)
     Tests  52 passed (52)
```

`tsc --strict --noEmit` clean on all four modules under the repository's own
compiler options.

---

## Wiring — the next commit

None of this is done yet. In dependency order:

1. **Schema.** Four additions to `drizzle/schema.ts`, then one migration
   (next free number is `0164`+ by count; check `drizzle/` for the actual tail):
   - `siteStopBaselines` — cached per `(facilityId | locationId, stopType, phase)`:
     sample count, median, MAD, p90, window start/end, `computedAt`. Cache only;
     `buildSiteBaseline` remains the authority.
   - `siteStopAlerts` — one row per raised alert with phase, severity, observed,
     median, sample count, `tripStopId`, and an acknowledgement column. Alerts are
     records, not notifications.
   - `tripPassportPackages` + `tripPassportPackageItems` — mirroring the
     `communicationPackages` shape already in the schema: `manifestHash`,
     `inputsHash`, `status`, `staleReasonsJson`, `builtByUserId`, `builtAt`,
     `supersedesPackageRef`.
   - `unitBinderSnapshots` — `unitId`, `satisfied`, `required`, `itemsJson`,
     `computedAt`. The task queue derives from the snapshot; it is not stored twice.

2. **Routers.** Follow `facilityDirectoryRouter.ts` for shape and
   `procedureAuthorization.test.ts` for the authorization contract:
   - `siteBaselineRouter.ts` — `baselineForSite`, `assessStop`, `acknowledgeAlert`
   - `tripPassportRouter.ts` — `buildPackage`, `checkStaleness`, `releaseWithAcknowledgement`
   - `safetyBinderRouter.ts` — `scoreUnit`, `fleetQueue`
   - Trip billing projection has no router of its own — it belongs inside the
     existing billing path, called where `evaluateBillingReadiness` already runs.

3. **Authorization.** Every new procedure needs an entry in
   `PROCEDURE_AUTHORIZATION_INVENTORY.md` and must pass
   `procedureAuthorization.test.ts` and `operationalApiAuthorization.test.ts`.

4. **Tenant scope.** New tables need coverage in the `tenantScope*.db.test.ts`
   family — follow `tenantScopeJobsTrips.db.test.ts`, which already covers trips
   and stops.

5. **Trip completion hook.** There is currently no `onTripComplete` anywhere in
   `server/`. Decide deliberately whether package assembly and billing projection
   run on completion, on demand, or in the worker (`server/_core/worker.ts`).
   Recommendation: **on demand, then cached.** Automatic assembly at completion
   would produce packages nobody looks at and stale ones nobody rebuilds.

6. **`todo.md`.** Replace the three open sections with the corrected state — see
   `todo-patch.md` beside this file.

---

## Open questions for you

1. **Service codes.** `tripBillingProjection` takes `serviceCodes: { distance, billableTime, disposal }` as input rather than assuming `KM` / `HR` / `DISP`. Where should the mapping live — `commercialSetupProfiles.servicesJson`, or a new per-customer column?
2. **Baseline window.** `buildSiteBaseline` deliberately does not filter by age; the caller passes the window. At a site visited twice a year, eighteen-month-old measurements are all there is. Do you want a default trailing window at the router, or genuinely all history?
3. **Binder requirement set.** `RequirementType[]` is passed in. It should almost certainly be seeded per jurisdiction and stay **unverified** until someone checks it, the same way the HOS profiles do — that is a P9 question, not a code one.
