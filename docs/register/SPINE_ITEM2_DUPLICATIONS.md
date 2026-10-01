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
| `fieldTicket` | signature status | `recordSignature` writes it | **engine copy deleted** (owner's ruling: a signature is the state recorded at signing) |
| `fieldTicket` | scope validation, job reconciliation | none | not a duplicate; stays unwired |
| `openShifts` | shift eligibility, interest | `openShiftsRouter.ts` inline | **router copy deleted**; the engine's `shiftEligibility` is the one rule (owner's ruling: the union of both), and the router enforces it |
| `complianceDocumentValidity` | document validity | `readinessComposer` / `dispatchReadiness` / tile and other readers | **resolved by #52** (rulings B and C); every reader now takes the canonical verdict |

**All four pairs are resolved** (2026-10-01). Each has one implementation; the last two were settled by the owner's rulings and applied on `claude/spine-item2-openshifts-fieldticket` (§2, §3 and "Item 2 — completion" below). Item 2 is recorded **COMPLETE** only once that branch is merged and CI on the resulting `main` commit is green; that record follows the merge.

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

**Follow-up (2026-10-01): the rule itself, not just the removed copy.** Deleting `detectBookingConflicts`
left the rule written out twice in live code and once more in memory, agreeing only by coincidence:
the award's SQL (`dispatchTransaction.awardAssignment`), the open-shift router's SQL
(`openShiftsRouter.personFacts`, added by #89) and an `overlaps` helper in `_core/openShifts.ts`. The
names guard could not see them because they were new names, not re-declared ones.

- **One rule:** `server/_core/bookingConflict.ts` — `ACTIVE_BOOKING_STATES` (tentative, confirmed),
  half-open `windowsOverlap`, resource identity by type and ref, as a function (`bookingConflicts`)
  and as a query predicate (`conflictingBookingsWhere`).
- **Callers:** the award's re-check and open-shift eligibility both query through
  `conflictingBookingsWhere`; `shiftEligibility` judges a commitment through `windowsOverlap`.
- **The award's check stays.** It is the final revalidation inside the transaction, immediately before
  the booking is written: state can change between eligibility and award. It keeps its own decision of
  which conflicts to ignore (a booking on the posting being awarded), which is the caller's business,
  not the rule's.
- **No behaviour changed:** the three copies already agreed; this makes them unable to drift.
- **Tests:** `server/bookingConflict.db.test.ts` writes every state × window × resource combination
  and requires the predicate and the function to select the same rows (10 of 64 per resource).
- **Guard** (`server/spineItem2Duplicates.test.ts`, "a booking conflict has one definition"): only
  `bookingConflict.ts` reads `resourceBookings`' window or state columns or names the holding states;
  the award and the router must call `conflictingBookingsWhere`; the open-shift engine compares no
  window with a window and declares no `overlaps`. Each of main's three copies, restored, fails it.

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

**Signature status: resolved by the owner's ruling — the signature is historical.**

- **The two answers.** A's `deriveSignatureStatus` recomputed the status from the line dispositions (all disputed → `refused`, mixed → `partially_accepted`). B, `recordSignature`, writes `result` / `signatureStatus` once, at signing (`partially_accepted` when a requested authority was refused, otherwise `accepted`), and nothing re-derives it after `decideLine`.
- **Ruling.** Keep B. A signature is the historical state created at signing; line decisions are a separate fact per line and never rewrite it. Invoice readiness is a different question: valid signature **and** required line decisions resolved **and** the existing billing requirements, answered by the existing `draftFromTicket`. A signature alone is never sufficient.
- **Survivor:** `recordSignature` (`closeoutRouter.ts`) for the signature; `draftFromTicket` (`_core/invoiceDraft.ts`, through `invoicing.draftFromTicket`) for readiness. **Removed:** `deriveSignatureStatus` and its 5 unit tests. **Callers migrated:** none (it had no production caller).
- **Behaviour retained.** `draftFromTicket` already refused an undecided line (`not_presented` blocks), a disputed line unless the contract allows partial invoices, an unsigned ticket and a ticket amended after signature. `invoicingRouter`'s "signed" input was never treated as sufficient, so no invoicing logic changed; the ruling is pinned rather than implemented.
- **Tests** (`server/fieldTicketSignatureSemantics.db.test.ts`, through the real `closeout.siteSign` / `closeout.lineDecide` / `invoicing.draftFromTicket`): signed stays signed — signer, time, payload hash, statement and ticket status byte-for-byte — after every line is disputed and after the decisions are corrected; an unsigned ticket's lines cannot be decided and lines accepted underneath it manufacture no signature; undecided lines block readiness; a disputed line blocks where the contract refuses partial invoices while the signature still reads `accepted`; all lines accepted and priced → ready, and drafting leaves the signature unchanged. Mutation: recomputing `signatureStatus` in `decideLine`, or dropping the `not_presented` blocker, fails 3 of the 5.
- **Guard:** `deriveSignatureStatus` is a removed name in `server/spineItem2Duplicates.test.ts`. `_core/billing.ts` and `LEASEOS_BILLING_RECORDS_CHAIN.md` no longer describe a roll-up.

**Scope validation and job reconciliation: not duplicated.**

- `validateFieldTicketScope` has no live counterpart. `closeout.ticketOpen` accepts any scope/trip combination, has no `loadId` input, and does not scope-check `tripId`.
- `reconcileJob` has no live counterpart. `closeoutState` is per ticket, and `evidenceChainWalk` names hops without judging them.
- Both stay unwired, for job close (SPINE item 4 and later).

## 3. `openShifts`: resolved by the owner's ruling — one rule, enforced by the router

**Characterized before the change.**

- **A:** `server/_core/openShifts.ts`, pure, imported only by its test. It refused `wrong_role`, `missing_qualification` (from a pre-filtered list), `on_approved_leave`, `not_rostered` (off-hitch), `overlaps_existing`, and an interest from an ineligible person.
- **B:** `server/openShiftsRouter.ts`, mounted as `shifts`. `shifts.eligibility` refused approved leave, a missing/expired licence and unknown/unverified/expired qualifications (through the C1b-3 read adapter). `shifts.expressInterest` checked **no** eligibility despite its comment, and the licence was read where `operators.id == userId` instead of the person link `operators.userId`.
- RED on `main` (`server/openShiftsEligibility.db.test.ts`): the original 12 cases all fail. A 13th, added later, pins the licence linkage: a stranger's operator row whose id equals the user's id must not be read as theirs, and reading `operators.id == userId` fails it.

**Ruling.** One canonical implementation preserving every restriction from both. The router calls it and enforces its result. Viewing (`shifts.read`), expressing interest (`shifts.interest`) and posting (`shifts.post`) stay distinct. The work-taking action fails closed.

**Survivor:** `shiftEligibility(post, PersonFacts)` in `_core/openShifts.ts`. Its refusals, all collected:

- `not_in_organization`, which short-circuits: nothing else is read or said;
- `wrong_role`;
- `not_rostered`: no active crew membership in the organization, or off-hitch on the day;
- `on_approved_leave`;
- `overlaps_existing`: tentative or confirmed operator bookings;
- `no_licence_recorded`: no operator record, two records, or a blank expiry;
- `licence_expired`;
- `qualification_unknown` / `_unverified` / `_expired`, taken from the adapter's structured verdict.

`candidatesFor` maps the same rule over many people. `expressInterest` also refuses an assigned post or one that is no longer open.

**Moved out of the router:**

- the licence-expiry judgement (`readExpiry`);
- the leave judgement (`isAbsent`);
- the qualification-code classification (`notHeld` → code);
- the post-kind and post-status refusals of `expressInterest`;
- the `EligibilityReason` type.

**Callers migrated:**

- `shifts.eligibility` and `shifts.expressInterest` both build `PersonFacts` with `personFacts()`, which reads records only: grants in the post's organization, the organization's crew roster, approved leave, `operatorForUserInScope`, operator bookings and `effectiveQualifications`. Both then call `shiftEligibility`.
- `expressInterest` throws `PRECONDITION_FAILED` on `NotEligible` and writes no row.

**Behaviour now enforced:**

- the eligible case passes;
- wrong role, not rostered, off-hitch, overlap, no licence, expired licence and missing qualification are each refused in the view and at the interest;
- an ambiguous operator record fails closed;
- input that claims roles, qualifications, a user or an organization gains nothing;
- another organization's worker gets `NOT_FOUND` on the post and reads `not_in_organization`;
- an ineligible worker can list the post but cannot take it, a dispatcher cannot express interest, and a worker cannot post.

**Guard** (`server/spineItem2Duplicates.test.ts`):

- `EligibilityReason` may not be declared again;
- both procedures must call `shiftEligibility`;
- the router may not import the judging helpers or name any refusal code.

A mutation that bypasses `shiftEligibility` in `expressInterest` fails the guard and 10 of the original 12 DB tests.

**Fixtures** in four older suites now give workers a roster and a linked operator record, which the stricter rule requires. `engineReachability`: `openShifts` is wired, and the unwired pin goes 86 → 85.

**Not resolved here.** dylanmark218-dot/leaseos-2#59 (open, design checkpoint) rewrites `openShiftsRouter.ts`, and it must rebase onto this one rule rather than reintroduce inline eligibility. The guard will refuse the latter.

## 4. `complianceDocumentValidity`: resolved by #52

This pair was resolved on its own branch, `claude/item2-compliance-validity`, merged as #52 under the
owner's rulings B and C. Its record is `docs/register/SPINE_ITEM2_COMPLIANCE_VALIDITY.md`. Every reader of
"is this compliance document in force?" now takes the canonical verdict (`validityOf`, through
`complianceDocumentValidity`):

- the dispatch composer and gate;
- the `documentExpiry` board tile (`server/widgetSources.ts` now imports `documentExpiry` from the adapter, and its inline `expiryState` is gone);
- insurance proof, medical fitness, the exception centre, the passport, customer-required documents and foreign TDG recognition.

`complianceDocumentValidity` is no longer declared unwired.

The survey's two findings on the adapter and the tile were addressed there as well:

- the verdict now names the row behind the version it reports (`documentId`), not the newest captured row;
- the tile reads the operator's own history through `documents.list`'s owner filter rather than an org-wide list capped at 100 rows, and a history at the cap reads `unknown`.

## Defect found in passing (outside item 2): fixed

`closeout.lineDecide` did not scope the ticket to the caller's organization. On `main` this was fixed in 9af505a (P0-A3, `requireTicket(actingScopeFor(caller))`). It is pinned by regression tests in dylanmark218-dot/leaseos-2#85, where removing the check fails 3 of 5. The sibling repository had the same defect, which is fixed in dylanmark218-dot/leaseos#9 (RED 3 of 5 on its `main`, GREEN 5 of 5).

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
- `fieldTicket` signature status.

(`complianceDocumentValidity` was the third, and #52 has resolved it.)

## Item 2 — completion

| Pair | Survivor | Removed | Callers migrated | Guard |
|---|---|---|---|---|
| `dispatchMatching` booking conflicts | `awardAssignment` → `decideAward` | `detectBookingConflicts`, `Booking`, `BookingConflict` | none (no callers) | removed names |
| `fieldTicket` disposition split | `draftFromTicket` | `splitByDisposition` | none | removed name |
| `fieldTicket` signed scope statement | `recordSignature` | `buildSignedScopeStatement`, `SignedScopeInput`, `hhmm` | none | removed names |
| `fieldTicket` signature status | `recordSignature` (signature) + `draftFromTicket` (readiness) | `deriveSignatureStatus` | none | removed name + `fieldTicketSignatureSemantics.db.test.ts` |
| `openShifts` eligibility / interest | `shiftEligibility` (`_core/openShifts.ts`) | the router's inline rule and `EligibilityReason` | `shifts.eligibility`, `shifts.expressInterest` | removed name + router-holds-no-rule guard |
| `complianceDocumentValidity` | `validityOf` via `complianceDocumentValidity` | the readers' inline expiry (#52) | every reader (#52) | #52's own |

**Net, the two rulings** (production code, `git diff --numstat`):

- `fieldTicket`: −20 / +5 in `_core/fieldTicket.ts`, and 2 / 2 comment lines in `_core/billing.ts`. One export is removed.
- `openShifts`: +98 / −43 in the engine and +83 / −65 in the router. That is **net +73 lines**. The router lost its judging code but gained a record reader (`personFacts`). The engine gained the licence, qualification and organization rules it previously lacked. One exported type (`EligibilityReason`) is removed.
- The reduction across item 2 is therefore in **answers, not lines**:
  - before, there were two answers each to five questions;
  - now each question has one answer;
  - six exports in total were removed by the first checkpoint, and two more by these rulings.
- **Tests:**
  - removed: 35 lines (the deleted roll-up's unit tests);
  - added: two DB suites (5 + 13 tests);
  - extended: the structural guard;
  - migrated: the engine unit tests (20).
