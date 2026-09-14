# LeaseOS — B12: Routing Constraint Compiler + Evidence Ledger

**Status:** built and tested. **131 tests across 8 engines**, all green (gate 10 held).
**Companion to:** `LEASEOS_TAXONOMY_ROUTING.md` · `LEASEOS_BILLING_RECORDS_CHAIN.md`

---

## 1. The chain now runs end to end

```
Job classification → Restriction profile → CONSTRAINT COMPILER → Route evaluation → Decision + evidence
   (taxonomy.ts)      (taxonomy.ts)      (routingCompiler.ts)   (routeEvaluation.ts)
```

The compiler's job is **subtraction**. Rather than handing the router every restriction that exists,
it emits only the checks this particular load needs. A tandem straight truck hauling water on a
paved highway resolves to **fewer than 8 checks** and never evaluates dangerous-goods corridors or
lease gate access. The same truck carrying crude picks up `dg_corridor` and `dg_time_restriction`
automatically.

`LAYER_CHECKS` is an explicit map from restriction layer → concrete checks, so the router's
workload is auditable: you can read off exactly what a given layer costs.

---

## 2. Gates

| # | Gate | How it is met | Tests |
|---|---|---|---|
| 1 | Classification deterministically generates the profile | `routeProfileId` is FNV-1a over key-sorted canonical inputs. Environment order cannot change it. **The clock is never hashed** — otherwise invalidation would fire on every run | 4 |
| 2 | Only applicable layers | `LAYER_CHECKS` expansion; asserted that a non-hazardous lease haul emits no DG or width checks | 4 |
| 3 | Jurisdiction/version/source aware | `jurisdiction` on the profile; every evidence row carries source, version, verifiedAt, confidence | ✓ |
| 4 | Unknown cannot silently become pass | `unknown` is its own result with its own counter. `combineAxis` puts `unknown` above `review` in precedence, so a neighbouring `pass` cannot absorb it. No path returns `clear` with an unknown present | 4 |
| 5 | Legal / feasible / preferred / unknown distinguished | `CHECK_AXIS` assigns each check an axis; four independent verdicts returned | 5 |
| 6 | Backroad/gravel/lease/seasonal are first-class | `surface_condition`, `weather_interaction`, `seasonal_closure`, `road_ban_level`, `lease_gate_access`, `road_owner_permission`, `turnaround_suitability` | ✓ |
| 7 | Decisions reproducible from stored inputs | `reproduceVerdict(evidence[])` recomputes verdict and explanation from the ledger alone — no map access | 2 |
| 8 | Offline keeps last verified dataset, states its age | `assessDatasetFreshness()` → fresh/aging/stale with age in days and the dataset version always named | 4 |
| 9 | Classification change invalidates dependent routes | `isProfileStale(storedId, currentInputs)` recompiles and compares | 4 |
| 10 | B11 tests stay green | 131/131, including all 94 from B11 | ✓ |

---

## 3. Why four axes, not one score

Conflating them is how a routing product tells a driver something untrue.

- **Legal** — permitted on this segment (bridge capacity, DG corridor, seasonal closure)
- **Feasible** — physically possible (clearance, turnaround, gate access). A 30 m combination can be
  perfectly legal on a road it cannot turn onto.
- **Preferred** — operational quality (gravel, school zones, grades). Not a legality question.
- **Data confidence** — how much of the above rests on verified information.

A gravel road returns `legal: pass` and `operationallyPreferred: pass` while being recorded on the
preferred axis, so it can never contribute to a legal refusal. Conversely an overheight load fails
`physicallyFeasible` while `legal` still passes.

---

## 4. Unknown-safety, concretely

Three distinct sources of `unknown`, all tested:

1. The map holds **no attribute** for the check → unknown
2. The attribute exists but records **no limit value** → unknown
3. A limit exists and is satisfied, but the **source is unverified** → `review`, not `pass`

That third case matters: a driver-reported bridge limit the vehicle happens to satisfy is not
clearance. It needs a person to confirm the number.

The explanation output states it plainly:

> `3 check(s) could not be evaluated on Lease Rd 7A — unknown is not treated as clear.`
> `ROUTING WARNING — regulatory data unverified. Human confirmation required.`

---

## 5. The evidence ledger

Every row is one check on one segment, carrying `inputs` — the actual arithmetic:

```
{ vehicleValue: 33500, limitValue: 55000, unit: "kg" }
```

So the answer to *"why did the system send this truck this way?"* is:

> 60000 kg exceeds 55000 kg on Hwy 40 north.

not *"the AI chose this route."*

`reproduceVerdict()` proves this is sufficient: it recomputes the identical verdict and explanation
from the ledger alone, years later, without the original map. If a decision can't be reproduced
from its own evidence, the evidence was incomplete — and there's a test asserting it can be.

---

## 6. Bug found and fixed during B12

Two compiler tests failed on `blocked` where `warning`/`review` was expected. The tests were right;
`deriveRoutingProfile` was **double-counting tare** — distributing the full tare across load-bearing
groups *and* separately adding 28% of truck tare to the steer axle. Every profile was modelling more
weight than the vehicle carries, so realistic loads reported as over-rating.

Fixed by distributing tare across **all** groups (the steer axle does carry part of the truck's own
weight) and cargo across **bearing groups only**. Axle loads now sum exactly to GVW.

That exposed a second issue: the tridem drive group was rated 24,000 kg — about 8,000/axle, too low
for heavy-spec. Corrected to 31,000 kg.

Worth noting the failure mode: the bug was invisible until a test asserted a *specific* dispatch
status. A test that only asserted "returns a profile" would have passed throughout.

---

## 7. Relationship to Master Manifest V7

The manifest's **§16 Segment evaluation** is marked `[BUILD]` and specifies PASS / REVIEW / BLOCKED /
UNKNOWN with rule checked, unit/load input, segment constraint, source, verification date and
confidence. **B12 implements exactly that.** That section can move to `[V6 PRESENT]`.

Manifest rules now enforced in code rather than by convention:

| Rule | Where |
|---|---|
| 4 — AI/GPS/OCR propose, people confirm | `zoneEvents.status: pending`, unverified → `review` |
| 5 — Unknown is never safe/clear/verified | `combineAxis` precedence; 4 tests |
| 8 — Tracking numbers are not primary keys | `tracking.ts`, `trackingReferences` |
| 10 — Regulatory rules are source-versioned data | `regulatoryThresholds`, every evidence row |

---

## 8. Still outstanding for routing

`[BUILD]` — the compiler and evaluator both work against **supplied** segments. There is no road
graph yet:

1. `roadSegments` / `bridges` tables persisting `SegmentAttribute` shape
2. Licensed or authoritative road-graph import — **not fabricated data**
3. Path-finding across the graph (currently evaluates a given route, doesn't choose between routes)
4. Offline route packages + rerouting
5. Route-version snapshot at dispatch
6. `permits` as first-class objects that re-evaluate when truck, load or route changes

`[VERIFY DATA]` — **still the gating item.** `regulatoryThresholds` ships `UNCONFIGURED` /
`unverified`, so every profile currently carries a warning and no route can return `clear`. That is
correct behaviour, and it also means routing output cannot be trusted for dispatch until confirmed
oversize/overweight triggers are loaded per jurisdiction, with a source and a date.
