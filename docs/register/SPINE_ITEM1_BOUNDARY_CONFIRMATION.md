# SPINE item 1 — per-boundary confirmation: resolver, chain rule and reader

The SPINE wiring plan (`docs/register/SPINE_WIRING_PLAN.md`, authored in the sibling repository
`leaseos` at `df51d65a` and restored here byte-for-byte — see
`docs/register/SPINE_WIRING_PLAN_PROVENANCE.md`) orders its work, and item 1 is: *which of a trip
stop's five timestamps does a person stand behind?* `siteBaseline` filters on exactly that and
cannot be wired to real data without it.

## What is in this repository

`server/_core/boundaryConfirmation.ts` — the resolver, byte-identical to leaseos's copy. It is pure:
it reads committed-receipt evidence (`assistantCommitReceipts.fieldManifest`, never `proposalFields`)
and returns `confirmed | unconfirmed | unknown` for each boundary. Tests:
`server/boundaryConfirmation.test.ts` (24 cases, the contract written RED before the code, now
GREEN) and `server/boundaryConfirmationRules.test.ts` (15 cases). Declared unwired in
`server/engineReachability.test.ts`.

`server/_core/boundaryEvidence.ts` — the chain rule `evidenceFromReceipts` and the receipt reader
`boundaryEvidenceForStop`, leaseos's code unchanged. The reader identifies the stop inside the
caller's organization (`orgScopeWhere(trips, scope)`), reads that stop's `assistantCommitReceipts`
(`targetType = 'trip_stop'` AND `targetRecordId = the stop`), hands the rows to the chain rule, and
the chain rule hands the newest commit's fields to the resolver. It implements no verdict of its
own. `server/boundaryEvidence.test.ts` (22 cases, pure) and `server/boundaryEvidence.db.test.ts`
(27 cases against the gate database: the real commit path and the real `tripStops.update` router,
record identity, tenant scope, provenance freshness, tampering, the unreachable boundary).

The last write the reader compares against — `tripStops.updatedAt` and `updatedByUserId` — exists
here since `0179_trip_stop_provenance.sql`, leaseos's `0169` reconciled forward without renaming
either repository's 0169 (`docs/register/MIGRATION_0169_RECONCILIATION.md`). The three writers
stamp it: `tripStops.create`, `tripStops.update` and the assistant commit, pinned by
`server/tripStopProvenance.test.ts`.

## What is still not wired

The chain is complete and nothing calls its top: the stop-timing router that would call
`boundaryEvidenceForStop` and feed `siteBaseline` is SPINE item 4 (stop timing, in path order),
not item 1. `boundaryConfirmation`, `boundaryEvidence` and `siteBaseline` therefore stay in
`DECLARED_UNWIRED` with that reason, and item 1 is complete as a chain, not as a wired feature.
The plan's second consumer, the billing path, reads the same resolver when
`tripBillingProjection` is adapted onto `priceLineAndRecord`; that adaptation is item 4's.

## The schema gap that stopped the reader, now closed

Until 0179 this repository's `tripStops` had no `updatedAt` or `updatedByUserId`: its migrations
stopped at 0168, and the 0169 slot was taken by `0169_defect_resolution.sql` (PR #4). The reader
was held back rather than improvised, because with no last write to compare against the only honest
answer was `unknown` for every stop. That is resolved by forward migration, not by renaming.

## `setupStartedAt` is a capture gap

No form collects it and `UnloadStopPatch` has no column for it, so no commit can speak for it. Because
`unknown` dominates in `combineBoundaries`, the `setup` and `wait` phases stay `unknown` however much
else is confirmed. Recorded in `UNREACHABLE_BOUNDARIES`, and not to be closed by adding the field to a
form without deciding who observes it and how.

## 2026-09-22 — three rulings

**`assistant.draft` → `invokeLLM` inside a request: not refactored.** Removing it means refusing the
operation or building the durable worker path, and neither is smuggled into another checkpoint. Keep
the one call, allow no second, revisit after the spine is wired; the target is zero. Precisely: the
pin (`server/_core/ai/workerBoundary.test.ts`) lives on the held secretary branch. On `main` the call
(`server/routers.ts`, `assistant.draft`) is live and nothing prevents a second.

**LOAD-CARRYING EQUIPMENT CAPACITY MODEL — deferred, not built.** Capacity belongs to the physical
load-carrying equipment, never to the power unit as such: a fixed vac body's capacity is the body's; a
tractor's is its trailers'. Owed: fixed body tanks, semi-trailer tankers, pups, multi-trailer
configurations, per-compartment capacity, total physical versus usable or legal capacity,
product-specific restrictions, equipment swaps. Until then, no trustworthy capacity means
`capacity_unknown` / `NOT_EVALUATED`. `units` gets no capacity column; `bulkFuelTanks.capacityLitres`
describes a fuel depot and is not reused.

**RELEASE BLOCKER — MIGRATION 0169 RECONCILIATION — resolved 2026-09-23.** Migration 0169 is
claimed twice: leaseos `main` carries `0169_trip_stop_provenance.sql`; this repository's `main`
carries `0169_defect_resolution.sql` (PR #4). Neither is renamed. This repository converges by
`0179_trip_stop_provenance.sql`; leaseos owes a defect-resolution port together with PR #4's code,
as a checkpoint of its own. Survey, hashes and decision: `docs/register/MIGRATION_0169_RECONCILIATION.md`.
history and CI database state.
