# LeaseOS — Driver Portfolio and Credential Wallet: the model (0169/0170)

**Release label:** unreleased, on `v23.25`. `LEASEOS_RELEASE` is unchanged; promotion is the owner's call.

This checkpoint builds the **credential and qualification model** and connects
it to the existing dispatch gate. It does not build the UI, and it does not add
the API router (see *Not built*).

## One gate, not two

The driver's readiness is not a second safety decision. `composeReadiness()`
now loads the requirement bindings that apply to the work and evaluates them
against the operator's credentials and equipment authorizations. The findings
enter through the same `extra` blocker list every other engine uses, and are
merged with `evaluateDispatchReadiness()`. The award fingerprint includes the
bindings and authorizations, so an award refuses a check made before a ticket
was verified or a binding changed.

```
Operator ─┬─ complianceDocuments (tickets; recorded by one person, verified by another)
          └─ operatorEquipmentAuthorizations (equipment)
                       │
driverRequirementBindings (company · customer · site · job type · equipment · job)
                       │
          evaluateDriverReadiness()  ──►  blockers  ──►  composeReadiness  ──►  evaluateDispatchReadiness
                       │
          wallet · dispatch view · expiry dashboard · history · one-credential share
```

## No new credential store

A driver's tickets were already stored as `complianceDocuments` rows, and
equipment already had `operatorEquipmentAuthorizations`. A third table of
certificates would give a second answer to "does this person hold H2S".
`server/_core/driverPortfolio.ts` reads those rows through the canonical rule,
`complianceDocumentValidity`, and adds what was missing:

- **Catalogue.** Driver licence, air brake, H2S Alive, First Aid/CPR, TDG,
  WHMIS, CSO/CSTS, Ground Disturbance, Confined Space, Fall Protection,
  respirator fit test, defensive driving and company orientation. Client and
  site orientations are `orientation:client:<key>` / `orientation:site:<key>`.
- **No renewal intervals.** The catalogue deliberately asserts none. How long a
  ticket lasts is the provider's statement on the certificate.
- **Medical fitness is not in the catalogue.** It still reaches dispatch only as
  "eligible".
- **Mandatory vs informational.** Only a mandatory requirement can produce a
  blocker. A missing optional certificate never stops a truck; it appears as a
  notice.
- **Named states.** A requirement is satisfied, or it is in one of these states:
  - `missing`
  - `unverified`
  - `rejected`
  - `expired`
  - `expires_during_job`
  - `no_expiry_recorded`
  - `class_unknown`
  - `insufficient_class`
  - `training_required`
  - `suspended`
  - `not_authorized`
  - `unknown_requirement`

  An expired ticket that has an unverified renewal waiting says so, and the
  action becomes "Safety to verify the renewal".
- **Severity.**
  - Missing, rejected, expired, lapsing mid-job, wrong class, or not authorized
    on the equipment: **blocking**, overridable by no one.
  - Unverified, no expiry recorded, or class not recorded: **unknown**, and a
    manager may override with a reason. This is the base gate's treatment of an
    unknown expiry.
- **Licence classes.** Alberta's hierarchy (1 ⊇ 2–5, 2 ⊇ 3–5, 3 and 4 ⊇ 5). A
  class string outside it is compared for equality, never guessed.
- **Expiry warnings** at 90, 60, 30, 14 and 7 days, which never block.

## Projections (pure, ready for the API and UI)

- **Wallet.** Shows `READY FOR WORK`, `ACTION REQUIRED` or `NOT READY` against
  the company baseline, with a card per requirement and for every ticket held.
  It is built to be cached offline and carries `validUntil`: the earlier of 24
  hours and the first lapse of a required ticket. `walletHeadlineAt()` turns a
  cached READY into `STALE — RECONNECT TO CONFIRM` after that time.
- **Dispatch view.** A tick or cross per requirement, with the reason. It shows
  no certificate numbers, providers or documents.
- **Expiry dashboard.** Every *current* credential across the fleet that has
  lapsed or falls inside the window, soonest first. A ticket already replaced by
  a verified renewal is history, not an alert.
- **History.** The current credential plus every earlier one, each with the
  reason it is no longer current (`superseded`, `expired`, `rejected`,
  `awaiting_verification`). Nothing is removed when a ticket expires.
- **One-credential share (QR).** An HMAC-signed token that lasts at most 7 days.
  It is re-evaluated when scanned, so a ticket that lapsed after the share was
  made reads as lapsed. A private credential is never shown.

## Persistence

- **`0169`.**
  - **`driverRequirementBindings`** records what a subject requires, whether it
    is mandatory or informational, and when it is in force. A subject is the
    company (`*`), a customer, a site, a job type, a piece of equipment or one
    job.
  - Each binding has an `orgRef`, and NULL means the historical single tenant. A
    binding applies only to work of the same organization, so one company's
    client requirements never reach another company's drivers.
  - **`driverPortfolioEvents`** records uploads, verifications, shares and
    dispatch use.
- **`0170`.** Makes `driverPortfolioEvents` append-only in the database.
  Triggers refuse an UPDATE or DELETE that bypasses the router.

## Tests

- **`server/_core/driverPortfolio.test.ts` (27 tests)** covers:
  - the catalogue
  - mandatory vs informational
  - unknown never satisfied
  - renewals
  - lapsing mid-job
  - warning tiers
  - licence classes
  - equipment states
  - the wallet and its offline expiry
  - the dispatch view carrying no identifiers
  - the dashboard and history
  - share tampering, expiry and privacy
  - binding matching and tenant isolation
- **`server/driverPortfolio.db.test.ts` (8 tests)** runs through
  `composeReadiness` against the migrated database. It covers:
  - a customer's mandatory ticket blocks, clears once verified, and moves the
    fingerprint
  - an informational requirement never blocks
  - another organization's binding does not apply
  - lapsing before `workEndsAt` blocks
  - the dispatch view leaks no certificate number
  - pending equipment authorization blocks
  - an unlinked operator is unknown rather than "not authorized"
  - the append-only triggers

## Not built, and named

- **The API router.** It will need these procedures:
  - the driver's own wallet, self-scoped
  - the Safety/Admin portfolio view
  - the dispatch check
  - the expiry dashboard
  - requirement bind and retire, refused by `bindingProblem()`
  - share issue and verify

  It will also need new permissions, a signing secret for shares, and the
  writers for `driverPortfolioEvents`. Those are authorization and
  configuration decisions, and they belong with the UI checkpoint.
- **The wallet and portfolio UI.**
- **Employee ID / QR card.**
- **Receipt capture from the wallet.** The ledger already exists:
  `expenseRecords` carries `paidPersonally`, `reimbursementRequired`, `jobId`,
  `unitId` and `operatorId`, and the fuel ledger is in place. The next step is
  capture and extraction into that ledger, not a new one.
- **AI secretary questions** over the portfolio ("who can I dispatch to Cenovus
  tomorrow"). These should read the projections above.
- **Requirement fields the system can't read yet.** Client and site
  orientations bind by the job's `customer` and `location` text, compared
  whole. There is no structured site key yet.
