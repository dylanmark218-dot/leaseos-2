# LEASEOS v22.18 — Communications reach dispatch

Release: **v22.18** · 272 tables (+1) · 74 migrations (+1) · **415 procedures** (+4) · 294 permissions (+2) · 100 sensitive (+1) · **1,604 tests** (+16) · parity 272/272 · `ci-gate.sh` PASS

---

## What this is

v22.17 could compute a communication plan and hand it back. Nobody had to look
at it. A plan dispatch cannot see is a report, and a report does not stop a
truck.

This makes it a control — and makes the company, not LeaseOS, decide how much of
a control it is.

---

## Completed

**The company's own policy, approved by a second person.** LeaseOS has no
opinion on whether an incomplete communication plan should stop a truck. A city
flatdeck operator and a lone worker hauling dangerous goods up a resource road
at night need different answers, and hard-coding either is wrong for the other.
So it is a record: proposed by one person, approved by another — because it
decides whether a driver leaves the yard — carrying `unknownPlanBlocks`,
`requireTransmitAuthorization`, `toleratedNoCommunicationKm` and
`loneWorkerRequiresSatellite`, with an effective window and a rationale. **No
policy is seeded.** Until two people approve one, dispatch warns about
communications and stops nothing.

The test that matters: same route, same truck, same day, and the only thing that
changes is that two people agreed an incomplete plan should stop a truck —
and now it does.

**Readiness reads the route it is named.** `ReadinessSubject` gains an optional
`routeApprovalRef`. With one, readiness reads the approval's verdict into the
route axis, blocks by name on a stale, revoked or superseded approval, and
computes the communication plan over its segments under the policy in force.
Without one it says *"No route named for this readiness — the route axis is not
evaluated"*, which replaces v22.16's now-false *"no routing data source is
loaded (P0/P5)"*. Every existing caller passes no route and keeps its behaviour
exactly.

**The lone-worker rule, where unknown counts against you.** `40 km of unknown
cellular` is not a reason to send somebody out there alone without a satellite
device; it is the reason to insist on one. So unknown and unavailable are summed
together as *beyond established cellular*, and the answer depends on the truck:
satellite recorded → review; recorded absent → **blocking**; not recorded →
unknown. It applies only when the driver is working alone and only when the
company has set the rule.

**A retired service authorizes nothing.** Weatheradio was shut down while its
transmitter frequencies stayed published on the same site. Without a retired
flag a frequency database will cheerfully tell a driver to rely on a service
that no longer transmits, and the driver finds out at the worst possible moment.
`channelRetire` records it with a note under the same authority as verifying a
channel, and the gate stops there — nothing further is worth evaluating. An
absent status reads active, so every row written before this keeps its meaning.

**The channels are inside the eligibility fingerprint.** `EligibilityFacts`
gains `communicationPlanVersion`, and `dispatchEligibilityChecks` gains
`routeApprovalRef` so the award-time recomputation asks the same question the
check asked rather than a smaller one. A road operator moving a haul road to
another channel between the check and the yard now refuses the award instead of
binding a driver to a stale brief.

---

## Files changed

| File | What |
|---|---|
| `drizzle/0075_communications_reach_dispatch.sql` | **new** — policies, retired services, route-aware checks |
| `server/commsDispatch.test.ts` | **new** — 16 tests |
| `server/_core/commRoute.ts` | retired-service gate; `OperatingContext`; the lone-worker rule |
| `server/readinessComposer.ts` | route- and communications-aware; `currentCommunicationPolicy` |
| `server/_core/dispatchAward.ts` | `EligibilityFacts.communicationPlanVersion` |
| `server/commsRouter.ts` | +4 procedures; **the serviceStatus read-back fix** |
| `server/dispatchRouter.ts` | route threaded through readiness, evaluate and the award recompute |
| `server/_core/recordsAuthorization.ts` | +2 permissions, +1 sensitive, 3 role blocks, 4 map entries |
| `drizzle/schema.ts`, `scripts/current-state.sh` | the tables and the narrative |
| 3 test files | pins moved deliberately |

## Bugs found

**1. A retired service came out of the database looking active.** `toChannel`
in the router rebuilt the engine's channel type from the row without
`serviceStatus` or `retiredNote`, so the flag was written, stored, and then
silently dropped on every read. The engine was right and the wiring threw its
answer away — the worst shape of bug, because the feature tests pass in
isolation. Caught by an integration test asking a *driver-facing* question
(`transmitCheck`) rather than an engine-level one. Both read paths fixed and
pinned.

**2. Test isolation, twice more.** An approved policy written by one test
decided the answer for a test above it, and a retired channel persisted between
runs. Both fixed by establishing the precondition explicitly — the standing
hazard in this repo, now three for three.

**3. My assertions tested the wrong thing.** Two tests asserted the overall
readiness verdict was not `blocked` when a bare operator fixture is blocked for
a missing licence, which has nothing to do with radio. Narrowed to the
communications blocker's own severity, which is both correct and a better test.

## Pins moved deliberately

Operational procedures **394 → 398**.

## Verification

Typecheck clean · parity 272/272 · 1,604/1,604 · production build · bare
`protectedProcedure` 0 · portal 36 external, 0 role · inbound 2 integration ·
current-state regenerated and matching. Full `ci-gate.sh` from an empty
database: **PASS**.

---

## Remaining gaps — named, not implied

**Still no importer.** ISED, BC and CRTC remain registered, blocked and
inspection-only. Channels are seeded or hand-recorded; coverage is whatever
somebody recorded. This is the largest remaining gap and it is blocked on a
licence question only a person can answer.

**Segment lengths come from the graph, or not at all.** A route segment with no
edge in any built graph contributes zero kilometres to the plan, which would
quietly understate a gap — so readiness names it
(`communication_plan_unmeasured_segments`) rather than reporting a shorter
route. Honest, but a real limitation: plans over segments outside a built graph
are incomplete by construction.

**A prompt is still not proof — and LeaseOS does not yet record either.** There
is no call-reminder feature, so nothing currently claims a radio call was made.
When one is built, the three facts must be three fields:
`promptDelivered` / `driverConfirmed` / `transmissionVerified`. Only a certified
radio interface can set the third. This is written down here so the first
version of that feature cannot quietly conflate them.

**The driver screen still does not exist.** All of this is server-side.

**Repeaters, tones and digital modes remain modelled and unexercised.**

## Next recommended step

**The offline communication package.** Everything above assumes a server the
truck can reach, and the whole product premise is that it cannot. The plan, its
zones, must-call points, channel changes and coverage are already computed and
hashed — caching that package before departure, and showing the driver which
version they are carrying, is the step that makes this real in the field rather
than in the office.
