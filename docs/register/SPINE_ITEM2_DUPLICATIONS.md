# SPINE item 2 — the four duplications, surveyed on current `main`

The SPINE wiring plan's item 2 (`docs/register/SPINE_WIRING_PLAN.md`, "resolve the four duplications
before wiring any of them") names `dispatchMatching`, `openShifts`, `complianceDocumentValidity` and
`fieldTicket`. Its premise is that each engine is a second answer to a question a live, inline path
already answers, and that the fix is to keep one answer and delete the other.

This record surveys all four against `main` at `9569195` (2026-09-25). It does not assume the plan's
descriptions still hold. For each pair it records the survivor and the reason, or the reason no survivor
has been chosen yet. Deletions are made one duplicate at a time, each in its own commit.

**The survey found that "four duplications" was too coarse.** Each engine holds several concepts. Some
of those concepts have a live twin and some have none. A concept with no live counterpart is unwired,
not duplicated, and item 2 does not delete it.

## Summary

| Engine | Concept | Live counterpart | Outcome here |
|---|---|---|---|
| `dispatchMatching` | booking conflicts | `awardAssignment` overlap query → `decideAward` | **engine copy deleted** (live one stricter) |
| `dispatchMatching` | suitability match, posting visibility | none | not a duplicate; stays unwired |
| `fieldTicket` | line disposition split | `draftFromTicket` (`_core/invoiceDraft.ts`) | **engine copy deleted** (live one stricter) |
| `fieldTicket` | signed scope statement text | `recordSignature` (`closeoutRouter.ts`) | **engine copy deleted** (display/evidence only) |
| `fieldTicket` | signature status | `recordSignature` writes it | **held: outcomes differ in billing; owner decision needed** |
| `fieldTicket` | scope validation, job reconciliation | none | not a duplicate; stays unwired |
| `openShifts` | shift eligibility, interest | `openShiftsRouter.ts` inline | **held: the two refuse different people; owner decision needed** |
| `complianceDocumentValidity` | document validity | `readinessComposer` / `dispatchReadiness` / tile | **owned by `claude/item2-compliance-validity`** (rulings B and C) |

Item 2 is therefore **not complete**. Two pairs need a ruling, and one is in progress on another branch.

---

## 1. `dispatchMatching`

The engine is `server/_core/dispatchMatching.ts`. It has no production importer; only its own test
imports it.

**Concept C3, booking conflicts: a real duplicate, resolved.**

- **A (engine, deleted):** `detectBookingConflicts(proposed, existing)`.
  - Keyed by `resourceId`.
  - Excludes any booking on the same `jobCode`.
  - No booking-state filter.
  - Half-open overlap.
  - Returns messages only and refuses nothing.
  - Callers: its own test only.
- **B (live, survives):** `awardAssignment` in `server/_core/dispatchTransaction.ts`.
  - Queries `resourceBookings` by `resourceType` + `resourceRef`.
  - Uses half-open overlap.
  - Only `bookingState in ('tentative','confirmed')` counts.
  - Skips bookings on the same posting.
  - Each conflict becomes a flat, non-overridable refusal in `decideAward` (`_core/dispatchAward.ts`, "Resource conflict — …").
  - A refused award writes an `assignment_blocked` audit row.
  - Reached from `dispatch.award`, a `roleProcedure` scoped with `scopedCheck` + `jobInScope`.
- **Differences, classified:**
  - **Resource key.** A used one string; B uses type + ref, so operator 5 cannot collide with unit 5. A was a bug.
  - **Booking state.** A counted released and cancelled bookings. That was stale behaviour.
  - **Self-exclusion.** A excluded every posting of the same job; B excludes only the same posting, so two postings of one job cannot hold the same unit at once. This is an intentional semantic difference, and B is the correct one.
  - **Outcome.** A produced text; B produces a refusal with an audit row.
- **Why B survives:** it is live and authorized; it is tenant-scoped; it filters by booking state; it refuses and audits.
- **Adapter or caller migration:** none, because A had no callers.
- **Schema:** `resourceBookings`, read by B only.
- **Tests:**
  - Before deleting A, three DB tests were added through the real `dispatch.award` (`server/complianceReadinessC1a.db.test.ts`, "SPINE item 2"):
    - an overlap on a second posting of the same job is refused, for both unit and operator, and writes no booking;
    - back-to-back bookings are allowed;
    - a released booking does not block.
  - Each was checked against a mutation: dropping the overlap push, or dropping the state filter, fails the matching test.
  - Tenant refusal was already pinned by the C1a tenant-scope test ("another organization's dispatcher cannot … award").
- **Known limit, not introduced here:** the posting-row lock serializes awards on one posting, not two awards on different postings that race for the same unit.

**Concepts C1/C2, suitability match and posting visibility: not duplicated.**

- `matchOperatorToJob` and `filterVisiblePostings` have no live twin. No procedure submits bids or serves a posting feed.
- The capability source tables are never read or written outside the engine: `operatorCapabilities`, `specialtyPools`, `operatorAvailability`, `onCallRotations`.
- `units` has no equipment-class, tank, payload, pump or DG columns.
- The nearest live logic is dispatch **eligibility** (`credentialBlocker`, `dispatchReadiness.ts`). The design keeps that apart from matching on purpose (`dispatchMatching.ts` header; `dispatchReadiness.ts:4-7`).
- These stay unwired. Wiring them needs data sources that don't exist yet, which is not item 2's work.
- The reachability note that said "dispatch surface uses its own path" has been corrected.
- **Gap noted, not fixed:** a slot's `requiredEquipmentClass` / `requiredTrailerClass` (`dispatchRoleService.ts`) is stored but checked nowhere.

## 2. `fieldTicket`

The engine is `server/_core/fieldTicket.ts`. It has no production importer; only comments in
`drizzle/schema.ts` and `_core/billing.ts` mention it. The live path is `server/closeoutRouter.ts` with
`server/_core/siteCloseout.ts`, plus the portal procedures that reuse `recordSignature` / `decideLine`.
`docs/document-control/DOCUMENT_CONTROL_NUMBERING_DESIGN_2026-09-23.md` identifies the same pairing.

**Line disposition split: a duplicate, resolved.**

- **A (deleted):** `splitByDisposition`. Buckets are accepted → billable, disputed → review, not_presented → unpresented. Callers: its own test only.
- **B (survives):** `draftFromTicket` (`_core/invoiceDraft.ts`), reached through `invoicingRouter`.
  - It uses the same three buckets, but a `not_presented` line **blocks** the invoice.
  - A disputed line is excluded or blocking according to the customer's `partialAcceptanceAllowed`.
  - Already-invoiced lines are excluded.
- **Difference:** A was a presentation-only split; B is a billing gate. B is stricter and contract-aware. Nothing called A, so no caller migrates.
- **Tests:** B is pinned by `server/invoicing.test.ts` (DB) and the invoice-draft cases.

**Signed scope statement text: a duplicate, resolved.**

- **A (deleted):** `buildSignedScopeStatement`. Signer, company, ticket number, site, UTC time window and per-line quantities. Callers: its own test only.
- **B (survives):** the statement composed in `recordSignature` (`closeoutRouter.ts`). Billable hours, loads, standby, the authorities exercised or refused, and a post-site note. Stored in `fieldTicketSignatures.signedScopeStatement`.
- **Difference:** the content differs. Neither text affects signature validity: the signature's `payloadHash` is the snapshot hash, and a device attestation signs that hash. The stored text is evidence only.
- B survives because it records the authority actually exercised, which A cannot know. A's extra fields (who, where, when, lines) are an enhancement B could adopt later, not a behaviour anything relies on.
- No migration. Existing rows are unaffected.

**Signature status: held for a ruling.** The two derive it from different inputs, and the outcomes differ in billing.

- A's `deriveSignatureStatus` reads the line dispositions:
  - all disputed → `refused`
  - some disputed and some accepted → `partially_accepted`
- B writes `result` / `signatureStatus` at signing time, before any line is decided:
  - `partially_accepted` when a requested authority was refused, otherwise `accepted`
  - it never writes `refused` or `no_representative`, and never re-derives after `decideLine`
- So a ticket whose every line was later disputed still reads `accepted`, and `invoicingRouter` counts it as signed. B's per-line blockers in `draftFromTicket` still stop the invoice.
- Choosing A means recomputing the stored status in `decideLine`, which changes the invoicing "signed" gate and the portal counts. Choosing B means deleting A. Either choice changes what billing sees, so it is not made in this checkpoint.

**Scope validation and job reconciliation: not duplicated.**

- `validateFieldTicketScope` has no live counterpart. `closeout.ticketOpen` accepts any scope/trip combination, has no `loadId` input, and does not scope-check `tripId`.
- `reconcileJob` has no live counterpart. `closeoutState` is per ticket, and `evidenceChainWalk` names hops without judging them.
- Both stay unwired, for job close (SPINE item 4 and later).

## 3. `openShifts`: held for a ruling

- **A:** `server/_core/openShifts.ts`, pure, imported only by `server/openShifts.test.ts`.
- **B:** `server/openShiftsRouter.ts`, mounted as `shifts` and called by nothing in `client/`.

They answer "may this person take this posted shift?" with **different refusals in both directions**:

- **Only A refuses:**
  - `wrong_role`
  - `not_rostered` (hitch / away)
  - `overlaps_existing`
  - an interest from an ineligible person (`NotEligible`)
- **Only B refuses:**
  - expired or missing licence
  - store-backed qualification verification and expiry, through `qualificationValidity.missingFrom`
  - a post that is not `status = open`
- **Only B has:** authorization (`shifts.post`, `shifts.read`, `shifts.interest`) and the post's tenant check.

Deleting either side weakens a refusal path, so no survivor is chosen here.

Two further facts bear on the ruling:

- **Another branch is changing both sides.** `claude/leaseos-communications-marketplace-p8ptqw` modifies `_core/openShifts.ts` and `openShiftsRouter.ts` and adds `openShiftsService.ts`. `claude/leaseos-compliance-survey-5faxe8` and `claude/training-academy-workforce-q3mdse` also touch the router.
- **Defects in B, recorded and not fixed here** (they are fixes, not consolidation):
  - `shifts.expressInterest` does not check eligibility, although its comment says "Refused unless eligible".
  - `shifts.eligibility` reads the licence from `operators` where `operators.id == userId`. The person link is `operators.userId`.
  - `shifts.eligibility` accepts any `userId`, and reads `leaveRequests` / `workerQualifications` without a tenant filter.

## 4. `complianceDocumentValidity`: owned elsewhere

`claude/item2-compliance-validity` is working this pair one step at a time, under the owner's rulings B and
C (`docs/register/SPINE_ITEM2_COMPLIANCE_VALIDITY.md` on that branch):

- the dispatch composer and gate now use `validityOf`;
- the `documentExpiry` board tile (`server/widgetSources.ts`) is its recorded next step.

`claude/leaseos-compliance-survey-5faxe8` (C1b-3) also touches the same files. It is not repeated here.

The survey's findings for that branch:

- The tile's inline `expiryState` differs from the canonical answer in display only (per-row against per-type, vocabulary, window rounding).
- The adapter `documentExpiry` takes `documentId` and `title` from the newest captured row, which may not be the row whose state it reports.
- The tile reads a document list capped at 100 rows, org-wide, then filters it in memory to the caller's own documents. An operator in a large organization can lose rows.

## Defect found in passing (outside item 2)

`closeout.lineDecide` (`server/closeoutRouter.ts`, internal) never calls `fieldTicketInScope`. Every sibling
ticket procedure in that router does, and it passes `customerAccountIdMustMatch: null`. So a caller holding
`closeout.line.decide` in one organization can change the disposition of another organization's ticket
line, given its ticket number. That is a tenant-scope write gap. It should be fixed on its own branch, as
a narrow integrity fix, and not inside a consolidation.

## Net effect of this checkpoint

Three duplicate answers were removed, one commit each. Every removed symbol had no production caller,
so no caller migrated and no behaviour changed. The survivors were already the live paths, and where a
survivor was untested it was pinned first.

| | Removed | Survivor |
|---|---|---|
| 1 | `detectBookingConflicts`, `Booking`, `BookingConflict` (`_core/dispatchMatching.ts`) | `awardAssignment` → `decideAward` |
| 2 | `splitByDisposition` (`_core/fieldTicket.ts`) | `draftFromTicket` |
| 3 | `buildSignedScopeStatement`, `SignedScopeInput`, private `hhmm` (`_core/fieldTicket.ts`) | `recordSignature`'s statement |

**Totals**

- Production code: 102 lines removed and 4 added. The 4 are a header comment in `dispatchMatching.ts` naming where booking conflicts are decided.
- Exports removed: 6. No file was deleted, because both engines keep concepts with no live counterpart.
- Tests:
  - 105 lines of tests of the deleted copies were removed.
  - Added: 3 DB tests of the award's conflict refusal, each checked against a mutation; 1 assertion pinning the stored signed-scope statement on the real portal signing path; the structural guard `server/spineItem2Duplicates.test.ts`.
  - The guard parses server, shared and client code, and fails if a removed name is declared again or a survivor disappears.
- Reachability notes corrected: `dispatchMatching` and `fieldTicket`.

The reduction is smaller than "four duplications" suggested. Most of the four engines turned out not to be
duplicates at all but unwired concepts with nothing to consolidate against. The remaining real
duplications are the ones that change refusals or billing, and those wait for a ruling:

- `openShifts` eligibility;
- `fieldTicket` signature status;
- `complianceDocumentValidity`, on its own branch.

**Item 2 is not complete.** It completes when:

- the openShifts ruling is made and applied;
- the signature-status ruling is made and applied;
- `claude/item2-compliance-validity` lands, including the `documentExpiry` tile.
