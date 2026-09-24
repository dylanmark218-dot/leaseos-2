# D-00 — may Document Control start under the SPINE moratorium? Decision brief

One ruling gates every checkpoint in `DOCUMENT_CONTROL_NUMBERING_DESIGN_2026-09-23.md`. This is the
same wall the compliance initiative hit, and the same shape of answer is available. Nothing here
argues the moratorium away; it puts the two coherent rulings side by side.

Measured at `929f721` (the survey SHA) and `0cd4817` (`origin/main` at the time). Since then `main` has restored the canonical plan and its guard (`server/spineWiringPlan.test.ts`, PR #13) and completed SPINE item 1 (PR #10); all thirteen spine engines remain declared unwired, so nothing below changes.

**Ruling recorded 2026-09-24 — see the last section.**

---

## The rule

`docs/register/SECRETARY_SPINE_MORATORIUM.md`, quoting `SPINE_WIRING_PLAN.md:3` (sibling repository):

> "no new engines until this path is wired."

The path is one driver, one job, end to end: dispatched, drives to a site, loads, hauls, disposes,
returns, job closes. Permitted work is "a deletion, a resolver, or a router over something already
written". All thirteen spine engines are still `DECLARED_UNWIRED` (`server/engineReachability.test.ts:28`).

## The finding that matters more than the choice

**The spine's own paperwork has no record layer.** On the one-driver-one-job path today:

| Step on the path | What the paper is | Where it lives today |
|---|---|---|
| Field ticket signed at site | the customer's copy of what happened | `fieldTickets` + `fieldTicketRevisions` + `fieldTicketDocuments` — frozen and hashed, **but its number is minted outside the transaction** (`closeoutRouter.ts:140`) and no ledger says what happened to a number that never became a ticket |
| Facility hands over ticket #773621 | the facility's evidence of acceptance | **one varchar column** (`disposalTickets.facilityTicketNumber`, no unique index, no issuer, no confirmation state) or free text (`tripStops.ticketNumber`, `manifests.scaleTickets`) |
| Driver photographs it | the original | `evidenceRecords` — real, sealed, but **not hashed at upload** and linked to nothing until someone commits a proposal |
| AI Secretary asks "which open ticket?" | the number | `contextPack.openTicketNumbers` — "numbers only, never rows" |
| Invoice drafted from the signed ticket | money | `billingSnapshots.payloadHash` — frozen, good |

Two of the thirteen spine engines are exactly this: `fieldTicket` (a declared-unwired duplicate of
the live `closeoutRouter` path; one of the "four duplications" the plan orders resolved) and
`offlineCapability` (the envelope a device's number claim would ride). So the question is not
"engine or no engine". It is whether the spine gets wired *through* a record layer, or wired first
and then re-plumbed when the record layer arrives.

## The two rulings

### A. Hold

The design waits until all thirteen spine engines leave `DECLARED_UNWIRED`. No Document Control
table, procedure or permission is added.

*What it costs:* the disposal receipt keeps living in one column; the field-ticket number keeps
being minted before its row; the `fieldTicket` duplication is resolved by picking one of two paths,
neither of which has a ledger, and the record layer later has to be fitted under a wired path
instead of the path being wired onto it. The AI-Secretary form work (PR #7) keeps proposing into a
`facilityTicketNumber` column that cannot say who issued the number.

*What it buys:* the moratorium stays literal. Nothing new to declare in the engine census.

### B. Carve out (recommended)

Rule that Checkpoint 1 of the design — definitions, records, revisions, links, external references,
the tenant column and ledger under the existing `trackingSequences` allocator, events — is the
record layer the spine's field-ticket and disposal steps need, and that Checkpoint 6 (the disposal
and field-ticket slice, which resolves the `fieldTicket` duplication by making `closeoutRouter` the
one path and registering its revisions and documents) **is SPINE item 2 work**, not work beside it.

Bound it the way compliance D-01 was bound:

* Checkpoints 1, 2 and 6 permitted, in that order, each one PR with the full gate.
* Checkpoints 3, 4, 5, 7, 8, 9 (templates, OCR, print, native, administration) **stay deferred**
  until the spine is wired. They are engine surface with no spine step depending on them.
* Every new module is either reached from a mounted router in its own PR, or declared in
  `DECLARED_UNWIRED` with the reason. No third state.
* The AI Secretary's worker-boundary ruling (the pinned `invokeLLM` call) is **not** folded into
  this one; it stays a separate decision.

*What it costs:* nine tables and one router added while the moratorium is in force, and the census
count rising by exactly the modules Checkpoint 1 mounts.

*What it buys:* the spine is wired once, onto a ledger, and the receipt from XYZ Disposal has an
issuer from the first day the driver photographs it.

## The precedent

`docs/compliance/unified-compliance-engine-design.md` §0 and §23 D-01 (`origin/main`, approved
2026-09-23): *"the moratorium stays. C1a and C1b are permitted (reconciliation, wiring, safety
fixes, consolidation); no C2+ standalone engine until the compliance path is wired through the
spine."* Ruling B is the same sentence with the checkpoint numbers changed.

## If you rule B, three more decisions gate Checkpoint 1 and nothing else does

| ID | Decision | Recommendation | Why it cannot wait |
|---|---|---|---|
| D-01 | Series reset default | `yearly` (today's live `FT-2026-000123`) | it is the `periodKey` in the ledger's unique index |
| D-02 | Archival `DOC-` number for externally issued documents | yes, optional per definition | it is whether `documentRecords.archivalLedgerId` exists on day one |
| D-03 | Numbering scope | company-wide; branch stays a later policy switch | it is whether `branch` joins the tenant-scoped unique index now |

D-04 to D-09 belong to Checkpoints 2, 5, 6 and 9 and are decided when those start.

## What happens after the ruling

* **A:** the branch stays as a design record; nothing else moves.
* **B:** the design commit is rebased onto current `main` (the survey header is updated to the new
  SHA and the schema line citations re-verified, because `main` has since added 89 lines to
  `drizzle/schema.ts`), the ruling is recorded in the design's §27 with the date, a PR is opened for
  the design alone, and Checkpoint 1 starts as its own PR taking the next free migration slot at
  that time.

No implementation starts on either ruling until the design PR is reviewed.

---

## Ruling — 2026-09-24

| ID | Ruling | Bound |
|---|---|---|
| **D-00** | **B — carve out** | Checkpoints 1, 2, 6 permitted in that order; 6 counts as SPINE item 2; 3, 4, 5, 7, 8, 9 deferred until the spine is wired; every new module reached or declared; AI worker-boundary ruling kept separate |
| **D-01** | yearly | `resetPeriod='yearly'` default; per-series override allowed |
| **D-02** | yes, optional per class | `archivalLedgerId` exists from Checkpoint 1; `archival_sequence_only` definitions draw from the `DOC` series |
| **D-03** | company-wide | `branch=''`; branch scoping stays a later policy switch on the existing column |

Recorded in the design's §27. The design was rebased onto `main` `6f52b57` the same day with its citations re-verified. Next: the design PR is reviewed; Checkpoint 1 then starts as its own PR taking the next free migration slot at that time (0175 as of this writing; check the collision register and every open branch first).
