# Driver credential stores: reconciliation matrix and recommendation (D-05)

Status: **recommendation for owner review. Nothing here is consolidated or migrated.**
Owner decision D-05 (2026-09-23): do not pick a store arbitrarily. Produce this matrix, recommend one
canonical authority with adapters or projections for the others, and bring it back before any
destructive consolidation.

Read against `main` at `38d26770` (after PR #4). Writers and readers are production call sites; test
files are excluded.

## Matrix

| Store / table | Current writers | Current readers | Authority it represents | Source of truth today for… | Duplicate fields | Conflicting semantics | Tenant scoping | Offline behaviour | Training Academy relationship |
|---|---|---|---|---|---|---|---|---|---|
| **`complianceDocuments`** (0019/0036; `ownerType`/`ownerId`) | `complianceRouter` (`credentialRecord`, `credentialVerify`), `db.ts` (field-route compliance document create), `hosRouter.recordScannedLog`, `workforceRouter` (course → credential via `COURSE_CREDENTIALS`) | **`readinessComposer`** (licence, TDG, medical, unit inspection, registration and insurance proof), `complianceRouter` (passport), `requirementRouter`, `insuranceRouter`, `auditRouter` (packages), `surfacesService` (exceptions), `trainingAcademyRouter` (foreign TDG recognition) | A **document**: licence, medical, certificate, inspection, registration. Includes government-issued evidence | What dispatch reads for the driver licence, TDG certificate and medical; the unit's CVIP/registration | `expiresAt`, `identifier`, `jurisdiction` duplicate `operators.license*`; TDG duplicates `academyQualifications(TDG_ROAD)` | `verificationStatus` is `needs_review\|verified\|rejected`; the composer counts `needs_review` as **present**; no `superseded` state | **None of its own.** Scoped through the owner (operator/unit via `coreRecordOwnership`) | Not in any offline package; `preDepartureCache` has no credential kind | Academy reads it (`foreignTdgRoadRecognize` requires a verified row); `academyQualifications.complianceDocumentId` links to it |
| **`academyQualifications`** (0107/0108) | `trainingAcademyRouter` only (`certificateIssue`, external/foreign recognition, supervision, company sign-off) | **`readinessComposer`** (Academy bindings), `trainingAcademyRouter` | A **qualification grant**: Academy certificate, external credential, direct supervision, company sign-off (`sourceKind`) | Training-derived qualifications bound to role/equipment/job/customer/site | TDG with `complianceDocuments.tdg_certificate`; Class 1/Q with `operators.licenseClass` | `status` `pending\|current\|expired\|revoked\|rejected`; keyed by **user**, not operator | Keyed to `userId`; tenant via the user's membership | None | It *is* the Academy's output |
| **`workerQualifications`** (0092) + `qualificationValidity.ts` | **No production writer found** | `openShiftsRouter`, `crewRouter`, `calendarRouter`, `readinessRouter` (shift readiness) | A **held qualification** (holding ref, certificate number, issued/expiry, supersede chain) | Shift eligibility, crew forecasts, calendar expiries, shift readiness | Everything overlaps `academyQualifications` and `complianceDocuments` | `verificationState` has `extracted`/`superseded` (richer than the others); a verified holding with no expiry reads as **unknown** here but as **present** in the composer | `tenantId` column (the only one of the five with one) | None | None: a parallel store the Academy never writes |
| **`operators.license*`** (legacy flat fields) | `routers.ts` (operator create/update), `workforceRouter` | `readinessComposer` (licence fallback when no document), `readinessRouter`, `openShiftsRouter`, `manifestCustodyRouter`, client showcase | The driver's **licence as typed in** | The licence when no structured document exists | `licenseExpiresAt` vs `complianceDocuments.driver_licence.expiresAt` | Always "present, unverified"; `licenseClass` free text, never checked by the composer (R-9) | Operator via `coreRecordOwnership` | None | None |
| **`operatorCapabilities`** (kind/code/label/expiresAt) | **None** | **None** | Matching attributes (licence, endorsement, orientation, equipment class…) | Nothing | Everything | n/a: dead schema | Via operator | n/a | n/a |

## What the matrix says

1. Dispatch already reads **two** stores (`complianceDocuments`, `academyQualifications`) plus the legacy
   field. Shift readiness, crews and open shifts read a **third** (`workerQualifications`) that nothing in
   production writes. The same person can be "qualified" for a shift and "not qualified" for dispatch,
   or the other way round. That is R-10 in credential form.
2. Only `workerQualifications` carries a tenant column. `complianceDocuments` is scoped only through its
   owner.
3. None of the five is in any offline package.

## Recommendation (for owner decision; not implemented)

**Canonical credential authority: `complianceDocuments`, as the one evidence-bearing credential
record, and `academyQualifications` as the one *qualification grant* record.** They are different
things (a document versus a decision that a person holds a qualification), so they are two
authorities with a single, declared boundary, not two competing stores:

| Concern | Canonical | The others become |
|---|---|---|
| A government-issued or external document (licence, medical, TDG card, CVIP, registration, insurance proof) | `complianceDocuments` (extended: `orgRef`, `superseded`, source class) | `operators.license*` becomes a **read-only legacy projection**, used only when no document exists (as today) and labelled so |
| A person holds a qualification (training, external recognition, supervision, sign-off) | `academyQualifications` | `workerQualifications` becomes a **projection** over the two canonical stores (a view or read adapter, *not* a writable table) so open shifts, crews, calendar and shift readiness read the same answer as dispatch |
| Matching attributes | derived from the two canonical stores | `operatorCapabilities`: leave in place; retire only by a separate, explicit decision (it has no reader or writer) |

Ordering, all non-destructive until the owner approves consolidation:

1. **Read adapter first:** one `credentialProjection(subject, at)` over `complianceDocuments` +
   `academyQualifications` (+ the legacy fallback), with source-class labels (`government_regulated`,
   `employer_issued`, `external_certificate`, `client_requirement`, `site_requirement`). Dispatch and
   shift readiness both read it. This is the natural first step of D-06 (shift readiness as a view
   over the composer).
2. **Behavioural-equivalence tests** between the adapter and the four `workerQualifications` readers.
3. Only then, with owner approval: stop reading `workerQualifications` directly, and decide whether
   to drop it or keep it as a materialised projection.

Owner questions carried with this:

* Should a `needs_review` licence document count as present for dispatch (it does today), or be
  UNKNOWN under D-02? *Recommended: UNKNOWN.*
* Contractor workers (0115, `organizationWorkers`) carry no credentials. Should their credentials
  live in the same two canonical stores, owned by the contractor organization? *Recommended: yes,
  scoped by `orgRef` so a contractor's record never lands in an employee file (D-14).*
