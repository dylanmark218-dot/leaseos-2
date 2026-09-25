# SPINE item 2 — compliance-document validity: the first of the four duplications

The SPINE wiring plan's item 2 is *resolve the four duplications before wiring any of them*
(`dispatchMatching`, `openShifts`, `complianceDocumentValidity`, `fieldTicket`). This records the
first, done alone, one duplication at a time as the owner directed.

## The duplication

"Is this compliance document in force?" had two answers:

- **canonical** — `server/_core/documentValidity.ts` (`validityOf`), reached through the adapter
  `server/_core/complianceDocumentValidity.ts`, which was written for this and never wired;
- **inline, live** — the dispatch composer's `credentialState` (`server/readinessComposer.ts`) picked
  a row itself (verified first, then the latest expiry, rejected skipped) and the gate's
  `credentialBlocker` (`server/_core/dispatchReadiness.ts`) read only its date.

Where they disagreed, dispatch cleared what the canonical answer did not:

| | case | inline (before) | canonical |
|---|---|---|---|
| D1 | only an unverified (`needs_review`) licence | cleared | unverified |
| D2 | older verified row, newer verified correction already expired | cleared (later date won) | expired |
| D3 | verified licence whose effective date has not come | cleared | not yet effective |
| D4 | verified licence with no expiry | unknown | in force (see ruling B) |
| L | only the legacy `operators.licenseExpiresAt` date | cleared | — (unverified; ruling) |

## Rulings (owner, 2026-09-24/25)

**C — one path.** Keep the canonical evaluator; redirect the inline logic to it. Adapters may format
the answer; they do not re-decide it. C1a's hardening (typed contract, no free-text inference, one
decision path) is kept, with no second registry or engine built to get it.

**B — a missing expiry is not a permanent one.** A verified document with no expiry is in force only
when its type genuinely does not expire. Otherwise it is incomplete and fails closed. No sentinel
dates (`2099`, `9999`): MariaDB `TIMESTAMP` makes them unsafe as well as untrue.

**Answers given for this checkpoint (2026-09-25):**
- an unverified credential at dispatch → the overridable unknown the gate already gave "expiry unknown";
- no document type is yet named as never-expiring (`EXPIRY_OPTIONAL_TYPES` is empty);
- the legacy licence date is an unverified licence;
- leaseos-2 first; port to leaseos once its CI runs.

## What changed

- `documentValidity`: two states — `incomplete` (verified, no expiry, type not in
  `EXPIRY_OPTIONAL_TYPES`) and `not_yet_effective` (verified, effective date not yet reached, nothing
  earlier in force). `capabilityStatus` blocks on both without change; `countsAsHeld` handles both
  explicitly; `documentExpiry` ranks both as work-stopping.
- `readinessComposer.credentialState` returns the canonical verdict for each accepted document type,
  taking the most favourable where several are accepted (a CVIP certificate *or* an annual inspection).
- `dispatchReadiness.credentialBlocker` maps the verdict onto its existing codes — none, rejected, not
  yet effective → `_missing`; expired → `_expired`; unverified, incomplete → `_unknown`; in force,
  expiring → clear. An unverified or incomplete credential whose own date has passed is `_expired`:
  evidence of expiry is never softened into an overridable finding. No classifier rule or override
  policy changed; under C1a, `_unknown` is UNKNOWN / BLOCK lifted only by an approved override policy.

Tests: `server/complianceValidityDispatch.db.test.ts` (real composer; D1, D2, D3, L and U fail on the
main this branched from), `server/complianceValidityGate.test.ts` (the mapping table),
`server/documentValidity.test.ts` (the contract).

## The consequence to expect

An operator whose only licence is the legacy date now carries `operator_licence_unknown` until a
licence document is filed and verified. Three test fixtures that built an "established" operator from
the legacy date alone needed a verified `driver_licence`; a fleet that has not migrated its licences
will see the same.

## The rest of the duplication — reconciled (2026-09-25)

A survey of every reader of `complianceDocuments` found the two sites named above and five more.
All seven now map the canonical verdict; none decides validity itself.

### The one answer

`server/_core/complianceDocumentValidity.ts`:

- `complianceRequirementValidity(rows, docTypes, at, noticeDays)` — the entry point. Each accepted
  type is judged by `documentValidity.validityOf` on its own rows; `mostFavourableVerdict` picks
  the one that stands (moved here from the composer). The verdict names its row (`documentId`) and,
  when it is `unverified`, the date the newest row claims (`claimedExpiresAt`) and whether that
  claim has already lapsed (`claimLapsed`). A lapsed claim may block; it never clears.
- Rows captured in the same instant order by id, so the same records always give the same verdict.
- `documentExpiry` (the tile's list) and `candidateVerdict` (the passport's grouping per subject,
  in `compliancePassport.ts`) are built on it.

### Every site, what it did, what it does

| Site | Before | Semantic differences from canonical | Now |
|---|---|---|---|
| Dispatch credentials (`readinessComposer.credentialState`) | converted earlier in this item | — | `complianceRequirementValidity` |
| documentExpiry tile (`widgetSources`) | per row: `needs_review`→unverified, no expiry→**current**, date vs now | no expiry read as current (canonical `incomplete`); not-yet-effective read as current; an upload beside the verified row showed as a second document; judged from the org's newest 100 rows | one row per type, the canonical state; presentation only (label, group, days to an established expiry); unknown shows **Not established**; reads the operator's own history via `documents.list`'s owner filter; a history at the cap reads `unknown` |
| Insurance proof, dispatch (`readinessComposer.policiesCovering`) | latest-expiring `insurance_proof`/`insurance_card` row, any state | an unverified or rejected upload with a later date displaced a verified proof | `proofFromDocuments` |
| Insurance proof, office (`insuranceRouter.policiesFor`) | the **first** `insurance_proof` row the database returned; ignored `insurance_card` | arbitrary row; a card dispatch accepted was invisible here | `proofFromDocuments`, same types as dispatch |
| Proof assessment (`insuranceRisk.assessCoverage`) | read the proof's date and status | verified proof with no expiry, or not yet effective, stood as proof | maps the verdict (table below); the company-level substitution is named `policy_record`, not a fabricated verified document |
| Medical fitness (`medicalFitnessForDispatch`, composer and `compliance.medicalEligibility`) | one row by latest expiry, read inline | verified no expiry → **yes**; not yet effective → **yes**; an older verified row passed over for a newer unchecked one | projection of the verdict |
| Exception centre (`surfacesService` → `exceptionCentre`) | per row: date vs now | a superseded licence raised **expired** beside its renewal in force; no-expiry and not-yet-effective raised nothing | verdict per owner and type over the owner's whole history; the review queue is a separate list of rows the SQL selected |
| Passport (`evaluateRequirement`, `compliance.passport`, requirement engine) | ranked candidates itself, read the winner's date | no expiry → **satisfied**; not yet effective → **satisfied**; older verified row outranked a newer expired correction; a combination read one subject's rows as another's versions | `candidateVerdict` per subject and type; two statuses added rather than rounding |
| Customer-required documents (`evaluateWorkContext`) | any verified row of the type | an **expired** verified document counted | in force by the verdict |
| Foreign TDG recognition (`academy.foreignTdgRoadRecognize`) | verified and has a date | an **expired** or not-yet-effective certificate was recognized | must be in force by the verdict |

### Final handling of the states that are not "in force"

| Canonical state | Dispatch gate | Tile | Insurance | Medical | Exception centre | Passport |
|---|---|---|---|---|---|---|
| `unverified` | `_unknown` (overridable) | Not established | `coverage_reported` (review) | unknown | review queue only | `evidence_unverified` (review) |
| `unverified`, claim lapsed | `_expired` | Not established | `document_expired` | no | expired | expired |
| `incomplete` (no expiry, type must have one) | `_unknown` | Not established | `coverage_reported` | unknown | "no expiry recorded" | `evidence_incomplete` (unknown) |
| `not_yet_effective` | `_missing` | Verified, not yet in force | `coverage_reported` | no | "not yet in force" | `not_yet_effective` (blocked) |
| `rejected` | `_missing` | Rejected on review | `document_missing` | no | — | `evidence_rejected` / withheld |
| `expired` | `_expired` | Expired | `document_expired` | no | expired | expired |
| `none` | `_missing` | (no row) | `document_missing` | unknown | — | missing |

Unknown is never shown or treated as expired or valid. `EXPIRY_OPTIONAL_TYPES` is still empty, so
every verified document without an expiry is `incomplete`.

### Guard

`server/complianceValidityGuard.test.ts` reads the source as a TypeScript AST:

- only `complianceDocumentValidity.ts` and `qualificationValidity.ts` import `validityOf`;
- each consumer above calls a canonical entry point and contains neither a document's
  `verificationStatus` compared with a verification literal nor a document's
  `expiresAt`/`issuedAt`/`effectiveFrom` compared with a time (receivers are narrowed per function,
  so the policy's own expiry or a bill's due date is not caught);
- the files importing `complianceDocuments` are a pinned census, each with a sentence on how it
  stands; a new reader fails until someone says whether it decides validity.

Each consumer, restored to its old code, fails the guard; each mapping, mutated, fails the tests.

### Tests

`complianceValidityConsumers.test.ts` (the verdict on the separating record shapes, each consumer's
mapping, insurance selection including multiple and no valid candidates, cross-consumer equivalence,
the tile through the real reader, the passport, the combination and customer-required documents);
`complianceValidityConsumers.db.test.ts` (the same records through `composeReadiness`,
`compliance.medicalEligibility`, `insurance.coverageForEntity` and the tile against the database;
entity scope for the proof; the exception centre; the TDG refusal); `surfaces.test.ts` (the exception
centre's per-type cases).

### Consequences to expect

- A verified document with no expiry now reads unknown/not established everywhere, not current.
- A proof, medical or licence verified but not yet effective no longer counts until it takes effect.
- The insurance office now accepts an `insurance_card` wherever dispatch did.
- `documents.list` takes an optional `{ ownerType, ownerId }`; without it the answer is unchanged.

### Recorded, not changed here

- **Tenant scope on insurance and medical reads** was a gap when this survey began and was closed
  on `main` by F1.1 (#56) while it ran: `insurance.coverageForEntity` now requires the financial
  entity and the covered entity in the caller's scope, and `compliance.medicalEligibility` the
  operator. Merged in here; the canonical reads sit behind those checks. Not this item's change.
- **Academy qualifications.** `trainingAcademyRouter` (the qualification check near the end of the
  file) filters `academyQualifications` by `status` and `expiresAt` inline, beside
  `qualificationValidity`. That is the same shape of duplication for a different table and belongs
  with the qualification engine, not here.
- `EXPIRY_OPTIONAL_TYPES` is a list, not document-type metadata. Moving it to canonical type
  metadata is a later hardening checkpoint.
- `compliancePassport.test.ts` › "through the registry" passes on a fresh database and fails on a
  second run against the same one; it is not re-run safe. The gate always uses a fresh database.
