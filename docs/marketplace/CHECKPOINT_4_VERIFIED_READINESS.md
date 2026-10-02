# Marketplace — Checkpoint 4 (P10.3): verified bid readiness (0192)

**Release label:** v23.29
**Migration:** `0192_marketplace_verified_readiness.sql`
**Date:** 2026-10-02
**Builds on:** checkpoints 1–3 (0189–0191)

## The rule this checkpoint records

> **Marketplace bid readiness ≠ dispatch readiness.**
> A company allowed to submit a tender is not a driver and a truck allowed to move. Marketplace
> readiness asks whether the *organization* has, on record, what the tender requires. Dispatch
> readiness asks, per operator and unit at assignment, after the award, whether that specific
> combination may legally and safely move — through the canonical gate
> (`readinessComposer.composeReadiness` → `evaluateDispatchReadiness`), with its own fingerprint,
> findings, overrides and enforcement mode. Nothing in the marketplace reaches that gate, bypasses
> it, or offers another path to a dispatched truck.

> **Marketplace readiness consumes canonical compliance truth.** It holds no credential of its own.
> The bid's *declared* qualifications stay in its content as what the bidder claims and decide
> nothing. What decides is what the registries hold, read through the engines that already judge
> validity.

## Survey: what the repository has, and what is reused

| Concern | Canonical component | Used as |
|---|---|---|
| Organization status | `organizations.status` | `organization` row; suspended/closed/missing BLOCK |
| Contractor profile | `contractorBusinessProfiles` (0115) | `contractor_profile`; none WARN, suspended/closed BLOCK |
| Organization-level (carrier) identity | `financialEntities` owned by the organization (0146); the subject `carrierProfileReviews` and `insurancePolicies` are keyed by | the carrier subject; **no financial entity on record → UNKNOWN, fail closed** |
| Carrier credentials (WCB clearance, safety fitness, permits, registrations) | `complianceDocuments`, ownerType `carrier`, ownerId = financial entity; validity by `complianceDocumentValidity` (the document engine) | `organization_document:<docType>`; in force PASS, expiring WARN, expired/rejected/none BLOCK, unverified UNKNOWN-blocking |
| Insurance | `insurancePolicies` / coverages / covered entities / the carrier's `insurance_proof`, as the insurance engine's `PolicyRecord`s; judged by `matchCustomerRequirements` with the tender as the customer | `insurance`; MATCH PASS, GAP BLOCK, UNKNOWN blocking |
| Equipment | units the organization owns (`coreRecordOwnership`), `units.vehicleType`, `inspectionStatus`, `maintenanceStatus` | `equipment`; compliant = class matches, inspection `current`, maintenance `clear` |
| Worker credentials (TDG, H2S, First Aid, WHMIS, licence classes) | `organizationWorkers` and owned operators resolved to users; holdings from `workerQualifications` (recorded) and `academyQualifications` (Academy-issued); held by the Academy's `countsAsHeld` (verified, unexpired, establishable expiry) | `worker_qualifications`, `dangerous_goods`; counts, never names |
| Enforcement | `outOfServiceOrders`, scope `carrier`, active, in the organization's tenant | `carrier_enforcement` BLOCK |
| Fingerprint | the dispatch award's convention: `canonicalJson` + `sha256`, with every governing expiry's lapsed state folded in (`expiryStateVersion`) | `MR-<sha256>` on every revision and evaluation |
| Audit | `marketplaceEvents` + `domainEventOutbox` (checkpoint 1); new `marketplaceReadinessEvaluations` mirroring `dispatchEligibilityChecks` | every decision recorded |
| Authorization / tenant | `roleProcedure` + `resolveActingScope` (no procedure reads an organization from input) | unchanged |
| Notifications | the workflow notification inbox (checkpoint 3) | unchanged |

Reused without change: `compliancePassport`'s private-field discipline (`PRIVATE_CREDENTIAL_FIELDS_NEVER_PROJECTED`
never leave the loader), `insuranceRisk.matchCustomerRequirements`, `qualificationValidity.countsAsHeld`,
`complianceDocumentValidity`, `auditPackage.canonicalJson/sha256`. The whole-company insurance read
(`insuranceRouter.policiesFor`) was lifted into `server/_core/insuranceCoverage.ts` so the marketplace
and the insurance surface read cover through one loader; it now reads the carrier's certificate of
insurance for a company-level read, which the router's original path left out.

Not modelled anywhere in the repository and therefore not invented: a permit registry (permits are
carrier compliance documents by type), HOS and driver availability at tender time (the dispatch
gate's questions, listed on every picture as *not evaluated* with who decides them).

## Model

**Tender requirements** are typed (`TenderRequirements`): worker qualification codes, organization
document types, a TDG flag (resolves to the Academy's `TDG_ROAD`), one insurance requirement
(coverage type, minimum limit in cents, additional-insured flag), equipment classes, a jurisdiction,
and client-specific statements that are listed and never evaluated. Checkpoint-1 postings are read
and mapped by `normalizeTenderRequirements`; no rules engine.

**The picture** (`MarketplaceReadiness`): `verdict` SUBMITTABLE or BLOCKED; every `check` as
PASS / WARN / BLOCK / UNKNOWN with `blocking` stated per row; `blockers`, `warnings`,
`notEvaluated`, `basis: "canonical_registries"`, `evaluatedAt`, `dependencyFingerprint`. A BLOCK
always blocks; an UNKNOWN blocks when the requirement is hard. Warnings never block and stay visible.

**Stage**: `submission` asks about the bidding window; `standing` (award, every later read) does
not, because the window closing is the tender's design, not a mark against the bidder. The
fingerprint excludes the window and the stage so it reads the same at submission and at award.

**States the user asked for, in repository words:** BID_DRAFT = a draft head, saved whatever the
picture says; BID_SUBMITTABLE = `verdict: "submittable"`; BID_BLOCKED = `verdict: "blocked"`
with the rows that say why; WARNING = rows in `warnings`; DISPATCH_READY = not a marketplace
state at all — the dispatch gate's `eligible` at assignment.

## Enforcement

At `bidSubmit`, inside the transaction and under the posting lock: actor authorized by
`roleProcedure`, the acting organization from membership, the tender's requirements loaded, the
facts gathered from the registries, the evaluator asked. A blocked verdict **commits** its
`marketplaceReadinessEvaluations` row (`submission_refused`) and its trail event
(`bid_submission_refused`) and then refuses, so the attempt is a fact. A submittable verdict
freezes the picture, its verdict and its fingerprint on the write-once revision and records a
`submission` evaluation. The draft is never touched by a refusal; an existing revision never is.

## Re-evaluation

The revision's picture is immutable. `bidsMine` (the bidder, full detail) and `bidsForPosting`
(the client, projection) compute `currentReadiness` live, with `readinessChangedSinceSubmission`
= the live fingerprint differs from the revision's. A bid never disappears because a certificate
lapsed: it stands as submitted, and the two pictures sit side by side.

At `award`, standing readiness is recomputed under the lock. A blocked bidder refuses the award
(`award_refused` evaluation, `award_refused_readiness` event, the bid still `submitted`); a
submittable one records an `award` evaluation and the award carries that picture, not the stale
one. Checkpoint 2's bridge is unchanged; the suite proves the marketplace writes no eligibility
check, booking or role binding for the job it hands over.

## What the client sees

`clientReadinessProjection`: eligibility in the client's words — *eligible*, *eligible with
warnings*, *not currently eligible* — each check's name and result, the counts, the fingerprint.
No detail strings, no holdings, no units, no users, no policy references. The suite asserts none of
the fixture's identifiers appear in the client's response. A bidder reads its own full picture and
only its own; `bidReadiness` evaluates the acting organization and takes no organization as input.

## Tests

* `server/_core/marketplaceReadiness.test.ts` (16, pure): legacy mapping; a compliant bidder;
  counts not names; each fail-closed path (missing qualification; unverified, rejected, no-expiry,
  expired holdings; insurance gap, reported, no proof, no limit, expired, none; no financial
  entity; each document state; wrong or held-back units; enforcement, suspension, profile,
  invitation, window, self-bid; unlinked workers); warnings only; an empty tender; stage; the
  fingerprint's stability, movement and lapse.
* `server/marketplaceReadiness.db.test.ts` (6, real router): compliant submits and blocked is
  refused with both decisions recorded and the draft intact; declaring what you lack changes
  nothing; warning-only submits and reads *eligible with warnings*; a lapse after submission —
  immutable submission picture, moving current picture, award refused and recorded, bid standing,
  award on restored cover, bridge and dispatch gate untouched; isolation and authorization —
  own picture only, projection to the client without identifiers, a forged organization in input
  ignored, a role without the permission refused; inactive and unverifiable organizations.
* `server/fixtures/marketplaceQualify.ts` writes the registries as their own surfaces do.

## After this checkpoint, in order

1. P10.5 — Marketplace / Job Board UI.
2. Private client ↔ bidder conversation on the existing message-board / channel architecture.
3. Completed-work closeout and ratings.
4. Matching / ranking improvements, only once real data exists.
