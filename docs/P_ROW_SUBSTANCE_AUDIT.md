# Register substance audit — DONE rows against their original definitions

**Run 2026-09-18/19, at `0b0a37a` (v22.92).** Method: the register as first written is recoverable
at `d6a3433`; each row now claiming DONE was compared against **its original definition there**,
not against its current wording. A row's current text is what I wrote when I closed it, so checking
a row against itself proves nothing.

Of 35 DONE rows, **21 have an original definition**. The other 14 (P3.8, P4.7, P7.1–P7.8, P8.1–P8.3,
P8.5) were added after `d6a3433` and have no earlier text; the only check available for those is
re-reading the owner decision that created them, which is how P8.2's missing test surfaced (v22.88).

## Findings — three rows closed without meeting a clause

| Row | The clause | What was actually there | Fixed in |
|---|---|---|---|
| **P3.6** | "…concurrency test, **master-search walk of the evidence chain**" | `searchEverything` resolved a number across a dozen tables and returned **flat records**. Somebody holding a number is almost never asking whether it exists — they are asking what it belongs to. | v22.90, `_core/evidenceChainWalk.ts` |
| **P3.2** | "accepted lines flow to billing **when customer config permits**" | The permission half did not exist. Readiness answered "accepted lines may still be billed" for every customer on every ticket, because `customerContractTerms` had **no term to consult** — a dozen billability flags and none for this. | v22.91, `0161` |
| **P3.1** | "…manifest references … **by reference**" | `manifests` carries `operatorId` **and** `driver`, `trailerUnitId` **and** `trailer`, `destinationFacilityId` **and** `facility`, and the custody state is built from **both**. Nothing declared which was authoritative, recorded that the text was a snapshot, or checked that they agreed. | v22.92, `_core/manifestFactReconciliation.ts` |

None of the three was a wrong branch or a bug. Each was a clause that had no implementation at all
and no note saying so — the failure mode a green gate cannot see, because nothing was testing for a
thing that was never built.

## Rows checked and clear

| Row | Clause checked | Evidence |
|---|---|---|
| P2.3 | profiles carry source/version/effective/verified; routes cite by version; unverified pass → review | verified and guarded at v22.80 |
| P3.3 | pending OCR/GPS/AI never become invoice lines | `unconfirmedValues` blocks: "cannot bill from an inference" |
| P3.4 | payload hash; amended-after-signature routed to review | `amended_after_signature` blocker |
| P3.5 | every exception class deep-links; inspector fifteen-day clock surfaces from five days out | `exceptionCentre.ts` implements the five-day surfacing by name |
| P3.7 | completing a work order never implies release | `mechanicRelease.ts`: "Closing a work order is an administrative act" |
| P4.1 | typed-handle audit over every production file; cross-tenant reads refused | the scan walks directories, not a list |
| P4.3 | the 0115–0117 chain tested through the **real procedures** | `contractorOperations.db.test`: one caller, zero direct DB writes |
| P4.4 | ingestion only through `repository.ts`; every chunk records its authorizing assessment | owner-signed at v22.74 |
| P5.1 | a fixture-backed screen **says so on its face** | every panel states "from records — <procedure>, n rows" or "demonstration layout — <reason>" |
| P5.2 | portals mount only their permitted procedures | `portals.panelsFor` refuses a portal the session does not hold, tested |
| P5.4 | a seeded, fixture-labelled organization walks the full chain | `demoDataset.db.test`: one caller, zero direct DB writes, `DEMO` marks asserted in rows |
| P0.1–P0.4 | reconciliation merges | already DONE **in the original**, so there is no later claim to check |

## Second pass — rows with no original text, checked against the owner decision that created them

| Row | The decision | What is there |
|---|---|---|
| **P8.2** | the named minimum tests | one was missing: "MANUAL/HYBRID/AUTO produce the same committed record shape" (fixed v22.88) |
| **P8.5** | internal-only material is *near misses, drug & alcohol test results, internal investigations* | **only internal investigations.** Near misses exist as an incident type and are not tier-gated at all; drug & alcohol results are not stored anywhere. Recorded and asked rather than fixed — see below. |

**The P8.5 ambiguity, unresolved on purpose.** The decision says this material is "accessible only to company
administration"; its stated rationale is that it "stays off the insurance books". Those are different rules. Admin-only
would hide near misses from the safety staff whose programme depends on seeing them. Off-the-books would not. Building
either reading would be a guess with a real cost attached, so it is a question rather than a commit.

## What this audit does not cover

- **The 14 rows with no original text.** Checking them means re-reading the owner decisions that
  created them, by hand. One pass over P8.2 found a missing test; the others have not had that pass.
- **Whether a clause is *well* implemented.** This checked that each clause exists, not that it is
  right. A clause can be met by code that is wrong in a way no one has thought to test.
- **The three fixes above are cores, not wiring.** Each is declared in
  `server/engineReachability.test.ts` with the reason it is not mounted — in every case because
  mounting changes an operational rule (when a manifest may be sealed, what a search result
  discloses) rather than because the work is unfinished.

## If this is run again

Compare against `d6a3433`, not against the current row. Three of the three findings were invisible
from the current text, because the current text is what the person closing the row believed.
