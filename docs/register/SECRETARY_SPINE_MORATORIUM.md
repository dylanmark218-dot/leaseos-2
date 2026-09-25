# The SPINE moratorium, read against the AI Secretary layer

This checkpoint was asked to remove the live `invokeLLM`-inside-a-mutation violation and wire one
real production path through the worker boundary. It did neither, because the moratorium forbids
both and the instruction was to resolve the moratorium first and stop if it binds.

What it did instead is the one thing the moratorium permits and the subsystem badly needed: the AI
layer was **outside the repository's engine census entirely**, and is now inside it and declared.

---

## 1. What the document requires

`docs/register/SPINE_WIRING_PLAN.md:3`:

> Against `9e1a75f82`. **A proposal, no code.** The moratorium stands: no new engines until this path
> is wired.

The path (`:6-8`) is one driver, one job, end to end — dispatched, drives to a site, loads, hauls,
disposes, returns, job closes as a clean record. Thirteen engines sit on it (`:10-26`), and the
dependencies force an order (`:45-57`):

1. **Per-boundary confirmation on `tripStops`** — "One resolver, read by both engines." (`:47-49`)
2. **Resolve the four duplications** — `dispatchMatching`, `openShifts`,
   `complianceDocumentValidity`, `fieldTicket`. "the highest-value item on this list" (`:50-54`)
3. **`offlineCapability` → HS1** (`:55`)
4. **The rest of the spine**, in path order (`:56-57`)

And the sentence that says what "engine" means here (`:59-60`):

> Nothing above needs a new engine. Every item is either a deletion, a resolver, or a router over
> something already written — which is the point of the moratorium.

## 2. How much of it is complete

**None of it.** All thirteen spine engines are still in `DECLARED_UNWIRED` in
`server/engineReachability.test.ts` — `dispatchMatching`, `openShifts`, `complianceDocumentValidity`,
`jurisdiction`, `routeApprovalPolicy`, `sourcePrecedence`, `truckRoutingAdapter`,
`preDepartureCache`, `offlineCapability`, `phoneLocationGate`, `siteBaseline`, `fieldTicket`,
`tripPassportPackage`.

The moratorium is therefore fully in force. Nothing has lapsed and nothing is arguably satisfied.

## 3. The earliest incomplete item, with evidence

**SPINE ordering item 1: per-boundary confirmation on `tripStops`.** It is incomplete, and the
repository says so in its own words rather than by inference.

`drizzle/0169_trip_stop_provenance.sql`, in the migration's own header:

> This is row provenance — who wrote this stop. It is NOT the per-boundary confirmation
> `siteBaseline` needs, which is a different fact about the five timestamps and **is still
> outstanding**. Neither replaces the other.

`drizzle/schema.ts` repeats it on the column. And `grep` finds no resolver: `BoundaryConfirmation`
appears only in `server/_core/siteBaseline.ts`, which **defines and consumes** it and is supplied by
nobody.

`siteBaseline.ts` already specifies the contract exactly (`:88-93`):

> `BoundaryConfirmation` is a VERDICT, derived from `proposalFields`' own `source` and `status`
> columns. It is deliberately not a parallel provenance vocabulary — the derivation reads that enum
> directly and keeps `corrected` alive, which is the case that matters: a `gps` field at `rejected`
> sitting beside a `human_corrected` field must not poison the corrected value.

### The smallest next coding task

A pure resolver mapping `proposalFields.source` × `proposalFields.status` →
`BoundaryConfirmation` (`confirmed | unconfirmed | unknown`), per `BoundaryKey` (`arrivedAt`,
`setupStartedAt`, `operationStartedAt`, `operationCompletedAt`, `departedAt`), reached from a
`tripStops` row via `assistantCommitReceipts.targetRecordId`.

It needs **no migration and no new table**: the columns it reads already exist. It is "one resolver,
read by both engines" — precisely the shape `SPINE_WIRING_PLAN.md:59` names as permitted work.
`siteBaseline.ts:38-44` even pins the hard case: `unconfirmed` and `unknown` both exclude a sample
and are different facts with different remedies, so the resolver must not collapse them.

## 4. May `server/ai/` remain as an isolated, unmerged implementation?

Yes — **unwired and declared**. Not yes — invisible.

The layer was `server/ai/`: twenty-one production modules outside `server/_core/`. The engine census
walks `server/_core` and nothing else (`engineReachability.test.ts:130`), so none of those modules
could be reached *or* declared. The guard's own header names this exact failure, about
`server/_core/knowledge/`:

> A guard against unwired engines that cannot see a directory reports health about a subsystem it
> has never looked at.

Being outside `_core` was never a permission to skip the declaration; it was the declaration going
unasked. That is the parallel architecture, and it is now gone:

- `server/ai/` → **`server/_core/ai/`**, following the `server/_core/knowledge/` precedent.
- All 21 modules **declared in `DECLARED_UNWIRED`** with reasons; the pinned count moves 55 → **76**.
- Nine of them form a mutual-unwired cluster (they import only each other) and are declared in that
  list too — what a whole subsystem held back by a moratorium looks like from inside the guard.

The number rising is the census becoming honest, not the gap growing. The modules were always
unwired; this is the first run in which that is stated.

### One layering fix the move forced

`server/ai/tools/caller.ts` imported `appRouter` from `server/routers.ts`. Under `_core/` that is a
cycle: the router layer imports the engine layer, so an engine importing the router closes it.
`engineReachability.test.ts:166` treats `_core/index.ts` and `_core/worker.ts` as the only sanctioned
places that may reach for `appRouter`.

`createCaller` is now a **required dependency** of `invokeTool`, supplied by whatever wires this up.
The module has no opinion about which router it talks to and no import back into the router layer.
This is strictly stronger than the convenience default it replaces.

---

## 5. What was NOT done, and why

| Asked | Status |
|---|---|
| Remove `assistant.draft → invokeLLM` from the request handler | **Not done.** Blocked below. |
| Wire a real production worker path | **Not done.** This is new-engine wiring for an off-spine subsystem, which is the moratorium's subject. |
| Turn the boundary pin from 1 to 0 | **Not done.** It pins the violation the refactor would remove; moving it to 0 now would assert something false. |
| Adversarial tests for the wired path | **Not done.** There is no wired path to attack. Writing tests against an unbuilt path is how a suite comes to assert a fiction — the mistake this branch already made once with invented procedure names. |

The violation is `server/routers.ts:691`, `invokeLLM` inside the `assistant.draft` mutation. It is
**pre-existing and live**, and it remains pinned at exactly one by
`server/_core/ai/workerBoundary.test.ts`, so a second call site fails the suite and removing the
first one fails it too.

Fixing it is not a small refactor dressed as one. `assistant.draft` currently returns a filled
proposal synchronously; the corrected shape returns a receipt and makes the driver wait for a
worker. That changes what a person sees in the cab, and the plan's own AI-adjacent engines
(`modelGateway`, `voiceTranscription`) are placed off the spine in "later phases"
(`SPINE_WIRING_PLAN.md:40`). Doing it now would be wiring an off-spine subsystem ahead of the spine,
under a moratorium that exists to stop exactly that.

**This needs an owner's ruling, not a workaround.** Two coherent options:

- **Hold.** The violation stays pinned at one until the spine is wired. Nothing new calls a model.
- **Carve out.** Rule that removing a pre-existing violation counts as the "deletion" the moratorium
  permits (`:59`), and authorise the refactor of `assistant.draft` alone — no new AI capability, no
  new tools wired, just the existing call moved behind the outbox.

The second is defensible on the document's own wording. It is still a ruling, and it is not mine.

---

## 6. The tank-capacity gap — a schema decision, deliberately not taken

The over-capacity rule cannot become `BLOCKED` in production, and it must not be faked.

- `units` has **no capacity column of any kind** — not tank, not body, not volume.
- `capacityLitres` exists only on `bulkFuelTanks`, which is a **fuel depot**, not a vacuum tank or a
  truck body. Reading it for a haul volume would compare a load against a fuel tank's size and call
  the answer enforcement.
- `SPINE_WIRING_PLAN.md` defines no canonical home for unit/body/tank capacity.

So **no column was added.** Current behaviour stands: `normalizeVolume` returns `NOT_EVALUATED` with
reason `capacity_unknown` whenever no capacity is supplied, and never `PASS`. A ceiling nobody
configured must not read as a ceiling nobody exceeded.

**Decision required before production over-capacity enforcement** — where does capacity belong?

1. A column on `units` (simplest; wrong the moment a tractor pulls two different trailers).
2. A per-trailer/body record, with the haul reading the *attached* body's capacity.
3. A per-load declared capacity captured at dispatch.

Each implies a different answer to "which unit's capacity" on a multi-trailer configuration, and
that is a domain question, not a migration question.

## 7. Proposal tools that remain impossible

Unchanged and still explicit in code as `PROPOSE_TOOLS_NOT_POSSIBLE_YET`
(`server/_core/ai/tools/registry.ts`), asserted by test:

| Tool | Needs |
|---|---|
| `propose.dutyEvent` | a `duty_event` form in `FORMS`. Hours by voice are a proposal into the HOS engine, never the legal log. |
| `propose.workOrder` | a `work_order` form in `FORMS` |
| `propose.billingLine` | a `billing_line` form in `FORMS` |

No permission was renamed into a procedure to make these appear to exist. That was the defect the
previous commit fixed and it stays fixed: `procedure` is typed `ProcedureName`, so an invented name
does not compile.
