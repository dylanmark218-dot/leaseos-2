# SPINE item 1 — per-boundary confirmation: the resolver only

The SPINE wiring plan (kept in the sibling repository, `leaseos`, as
`docs/register/SPINE_WIRING_PLAN.md`) orders its work, and item 1 is: *which of a trip stop's five
timestamps does a person stand behind?* `siteBaseline` filters on exactly that and cannot be wired to
real data without it.

## What is in this repository

`server/_core/boundaryConfirmation.ts` — the resolver, identical in code to leaseos's copy. It is pure:
it reads committed-receipt evidence (`assistantCommitReceipts.fieldManifest`, never `proposalFields`)
and returns `confirmed | unconfirmed | unknown` for each boundary. Tests:
`server/boundaryConfirmation.test.ts` (24 cases, the contract written RED before the code) and
`server/boundaryConfirmationRules.test.ts` (13 cases). Declared unwired in
`server/engineReachability.test.ts`.

The precedence, per boundary: only the five boundary keys are read; `setupStartedAt` is refused;
`rejected` is ignored; evidence that cannot be read makes that boundary `unknown`; otherwise the newest
`committedAt` wins, `confirmed`/`corrected` read `confirmed` and `proposed` reads `unconfirmed`; an
exact tie resolves to the weaker verdict; array order never decides anything. `unconfirmed` and
`unknown` are never collapsed.

## What is not, and why — a schema gap, stopped and reported

leaseos also carries the **receipt reader** (`boundaryEvidence.ts`): it reads a stop's receipts inside
the caller's organization and refuses them when the stop was written after its newest commit. That
check compares `tripStops.updatedAt` with the receipt's `committedAt`.

**This repository's `tripStops` has no `updatedAt`.** Its migrations stop at `0168`; it never received
the trip-stop provenance migration (`0169_trip_stop_provenance.sql` in leaseos), so it has none of
`recordedByUserId`, `recordedSource`, `updatedByUserId`, `updatedSource`, `updatedAt`. Without a
recorded last write, an edit made through `tripStops.update` after a commit leaves no trace, and no
reader here could tell whether a receipt still describes the row. The only honest reader would answer
`unknown` for every stop, which is not worth shipping.

Adding that migration here is a schema change this checkpoint was told not to make, and it would land
in a contested slot — see below. So the reader stops here, reported rather than improvised.

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

**RELEASE-BLOCKING — migration 0169 is claimed twice.** leaseos `main` carries
`0169_trip_stop_provenance.sql`; PR #4 here (`readiness-defect-repair`) adds
`0169_defect_resolution.sql`; and this repository has no trip-stop provenance at all. Two migrations
cannot both own one canonical number. Resolve it before the next migration-bearing feature in either
repository, and do not rename an applied migration without checking each environment's migration
history and CI database state.
