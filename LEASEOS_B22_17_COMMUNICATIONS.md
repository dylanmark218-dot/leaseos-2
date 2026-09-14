# LEASEOS v22.17 — Communications on the route

Release: **v22.17** · 271 tables (+7) · 73 migrations (+1) · **411 procedures** (+16) · 292 permissions (+11) · 99 sensitive (+4) · **1,588 tests** (+61) · parity 271/271 · `ci-gate.sh` PASS

---

## What this is

The routing graph (v22.16) answers *what roads connect A and B*. The four-axis
evaluator (v22.0–v22.15) answers *whether this truck may travel them*. Neither
answers the question a driver on a resource road at night actually needs
answered: **what do I talk on, and where does that stop working?**

That is this module. It does not become a fifth axis. The four axes are about
permission to move; communication is about being reachable, with a different
failure mode, and fusing them would let a good radio plan argue a truck onto a
bridge. The plan travels beside the verdict.

The rule underneath everything here:

> **A frequency is not a permission to transmit.**

Knowing that LADD 1 is 154.100 MHz and being authorized to key up on it are two
records, and nothing in the schema lets the first imply the second.

---

## Completed

**The authority hierarchy.** Posted sign ▸ operator instruction ▸ regulator ▸
planning map ▸ company entry ▸ driver observation ▸ community reference ▸
unverified submission. Resolution is authority first, then specificity, then
freshness — never nearest, never newest-wins. Every candidate that lost comes
back with the reason it lost. BC states plainly that its channel maps are
planning tools and the posted sign governs, so the sign outranks every dataset
in the building, including the regulator's own.

**Geographic conditions as stated arithmetic.** ISED's western and northern
mobile appendix writes exclusions into the authorization itself — a latitude
line, a radius around a town — which is exactly why a static "LADD 1–4" menu is
unsafe. The engine answers:

```
LAD-1 · 154.100 MHz
Excluded south of 53°30′00″N; this position is 52.2700N — 137 km south of
the line (Alberta exclusion south of 53°30′00″)
```

Not "restricted." The same truck, the same licence, 300 km north of there reads
`authorized`, and the test proves both.

**Five gates, and `unknown` never upgrades.** Channel record verified · service
class operational · geography · company authorization in force · unit carries
and has been programmed for it. `authorized` requires every gate to say yes; one
`no` is `not_authorized`; anything else is `unknown`. A public-safety or amateur
allocation is never offered as an operational channel, licence on file or not.

**The channel banks, seeded unverified.** BC RR-01…35, LD-01…14, Canadian CB/GRS
1–40, and the ISED B1 western bank (LAD-1…4 plus the Alberta frequencies with
their Strathmore, Bonnyville, Crossfield and Lake Louise exclusions). 99 rows,
each carrying its citation, **every one `unverified`** — so a seed alone always
answers `unknown`, and a person must open the cited page before anything reads
`authorized`. LAD-2 and LAD-3 carry BC/YT/NT/NU only; that row is what stops
LeaseOS telling an Alberta driver to use LADD 2 because their radio has it.
No company or operator channel is seeded: those arrive from the operator's
road-use document or a posted sign, because a frequency scraped off a scanner
site may be expired, reassigned or licensed to somebody else.

**The sign is the only route to sign authority.** `assignmentRecord` **refuses**
`posted_sign` outright — a sign is what a driver reads off the road, not
something an office types in from a map. A driver photographs it, the office
confirms it, and the assignment is written at posted-sign tier. Neither person
can do both halves.

**Temporary changes expire by arithmetic.** An operator moving a haul road to
another channel for one week governs inside its window and hands the road back
after, with both records kept. Same `from`-inclusive / `to`-exclusive rule a
spring road ban uses, so nobody has to remember two.

**The plan along a path** — zones by kilometre, channel-change points, the
operator's own calling convention, must-call points, coverage by medium, and the
five-level redundancy ladder. `unknownChannelKm` (nobody has said) and
`noCommunicationKm` (somebody has said there is nothing) stay different facts,
and the verdict treats them differently.

**Dispatch reads it as policy, not law.** `ADVISORY_POLICY` warns. A company
hauling DG with lone workers sets `unknownPlanBlocks` and gets a blocking
blocker from the same code. A channel the company is *refused* on is blocking
and overridable by no one.

**Communications joined the route fingerprint.** A confirmed sign or a temporary
operator change moves the hash, and yesterday's approval goes stale naming *the
radio channels on the route* — using v22.15's machinery, not new machinery.

---

## Files changed

| File | What |
|---|---|
| `server/_core/commRoute.ts` | **new** — the pure engine |
| `server/_core/radioChannelSeeds.ts` | **new** — 99 candidate rows with citations |
| `server/commsRouter.ts` | **new** — 16 procedures |
| `drizzle/0074_communications.sql` | **new** — 7 tables + the source-category widening |
| `drizzle/schema.ts` | +7 tables; `externalDataSources.category` gains `spectrum`, `coverage` |
| `server/_core/recordsAuthorization.ts` | +11 permissions, +4 sensitive, 8 role blocks, 16 map entries |
| `server/_core/externalSourceSeeds.ts` | +6 sources, all unverified, with publisher caveats |
| `server/_core/externalDataRegistry.ts` | `SourceCategory` gains two members |
| `server/_core/structures.ts` | `RouteDependencies.communicationsPlan` (optional) |
| `server/spatialRouter.ts` | resolves the governing channel into the fingerprint |
| `server/geoRouter.ts` | `routeCompute({ includeCommunications })`, default false |
| `server/routers.ts` | mounts `comms` |
| `DATA_SOURCES.md`, `scripts/current-state.sh` | the counts and the new blockers |
| 4 test files | pins moved deliberately (below) |

## Schema

`radioChannels` · `companyRadioAuthorizations` · `unitRadioCapabilities` ·
`roadRadioAssignments` · `radioSignObservations` · `communicationCoverage` ·
`communicationPlans`. Conditions live on the channel row as JSON rather than in
a table of their own, because a condition is not independently verifiable — a
person verifies the channel against the appendix, and the appendix is where the
conditions are written. One verification, one row.

## Tests

**1,527 → 1,588** (+61; 45 pure, 16 through the database). 89 → 91 files. Every
assertion is an outcome — `authorized` / `not_authorized` /
`requires_posted_channel` / `unknown` — never "returns a result".

---

## Bugs found

**1. A temporary channel change did nothing when it shared a timestamp with the
standing record.** Resolution at equal authority ordered on freshness alone.
MariaDB `timestamp` is second-precision, and both assignments normally come from
one road-use document entered in one sitting — so the standing record won the tie
and **the driver would have been briefed on the old channel for the entire week
the operator's change was in force.** Root cause: freshness is the wrong
tiebreak when one record is dated and the other is standing. Fixed by ordering
specificity above freshness — a bounded window is more specific than a standing
assignment — which is v22.15's "most restrictive governs, never the more
permissive just because it was recorded later", applied to channels. Regression
test pins it at an identical timestamp, in both argument orders, and pins that
specificity breaks ties **without** outranking a posted sign.

**2. `roleProcedure` takes the procedure name; I passed the permission.** All 16
call sites. Caught at wiring time by the check that refuses to let an unmapped
procedure degrade to authenticated-only — the failure was loud and immediate,
which is the design working.

**3. A test assumed global database state** rather than establishing it — the
standing hazard in this repo. It read a seeded channel as unverified, which held
on the gate's clean database and broke on the second run against a dirty one.
Fixed by establishing the precondition explicitly, not by resetting the database.

## Pins moved deliberately

- Source registry **8 verified / 3 blocked → 8 / 9**. Six spectrum and coverage
  sources added, **not one licence-cleared**: the ISED appendices are published
  openly, but redistributing a channel bank to field tablets as operational data
  is a separate permission nobody has confirmed. Inspection only.
- Operational procedures **378 → 394**.
- Route approval dependencies **7 → 8**.

## Verification

Typecheck clean · parity 271/271 · 1,588/1,588 · production build · bare
`protectedProcedure` 0 · portal 36 external, 0 role · inbound 2 integration ·
current-state regenerated and matching. Full `ci-gate.sh` from an empty
database: **PASS**.

---

## Remaining gaps — named, not implied

**No importer exists for any of it.** ISED SMS, the B1 appendix, BC's channel
maps and CRTC coverage are registered, blocked and inspection-only. Channels are
seeded or hand-recorded; road assignments are recorded or confirmed from a field
observation; coverage is whatever somebody has recorded. **No spectrum or
cellular layer has been ingested.**

**Every seeded frequency is unverified and stays that way until a person checks
it.** The banks came from research with ISED citations attached. They were not
verified against the live publications during this build, which is precisely why
every row lands unverified and controller-only to verify — the same posture as
P9. `AB-166.620` carries Alberta-only and a note that ISED states further
exclusions this seed does not capture; the channel's unverified status is what
keeps that honest rather than confidently wrong.

**Dispatch composition is not wired.** `communicationBlockers` returns blockers
in B12's vocabulary and `planForPath` hands them back, but `composeReadiness`
takes no route and so does not yet consume them. Wiring it means threading route
context through the readiness subject and into the award fingerprint — a real
change, deliberately not half-done here.

**Repeaters, tones and digital modes are modelled, not exercised.** The columns
exist (`toneRxHz`, `toneTxHz`, `systemType: repeater | trunked`); nothing writes
a repeater pair or a CTCSS tone yet, and DMR colour code, time slot and talkgroup
have no home.

**The driver screen does not exist.** This is server-side and proven in Node.

## Next recommended step

**Wire the plan into dispatch readiness**, because a communication plan that
dispatch cannot see is a report rather than a control — and it is the last short
step before this module changes what actually happens at the yard gate. The
alternative, the ISED/CRTC importers, is larger and blocked on a licence
question only a person can answer.

---

## Live demonstration

`scripts/demo-v22_17.ts`, run against the township actually imported from
Alberta's service. Every line below is read off the running system:

```
IMPORT   293 road segments from ats_road_allowance
GRAPH    293 segments → 246 routable edges, 253 nodes, 8 components
CHANNELS 99 seeded — 0 verified, 99 unverified
ROUTE    25 segments, 13.7 km
VERDICT  warning · legal unknown · unknown 100 · failing 0

COMMS (nothing recorded)
  verdict unknown · 13.7 km of 13.7 km with no channel on record
  "Unknown is not coverage — this route's communication plan is incomplete."

COMMS (operator document recorded)
  KM 0–6.3     LAD-4        unknown   Channel record is unverified — seeded
                                      from ISED B1 and not yet checked
                                      against it by a person
  KM 6.3–13.7  AB-163.050   unknown   (same)
  must-call at km 2, 4, 6
  cellular: 0 km available, 7.4 km unavailable, 6.3 km unknown

TRANSMIT LAD-4 @ 53.6209N — AUTHORIZED
  channel_record         yes  Verified against ISED B1
  service_class          yes  land mobile b1 is an operational class
  geography              yes  AB is among the permitted provinces
  company_authorization  yes  Company licence L-88231 verified and in force
  unit_capability        yes  In the unit's programming profile AB-NORTH-07

TRANSMIT LAD-1 @ 52.2700N — NOT_AUTHORIZED
  Excluded south of 53°30′00″N; this position is 52.2700N — 137 km south
  of the line (Alberta exclusion south of 53°30′00″)

SIGN     driver photographed "LAD-1" → office confirmed → posted_sign authority
APPROVAL before: current · after: STALE
         the radio channels on the route changed since this route was approved
```

Two things worth reading twice. The plan is `unknown` on a route where both
channels are *known* — because the channel records are seeded and unverified,
and that is the correct answer until a person opens the ISED page. And the
same truck with the same verified licence is `AUTHORIZED` at 53.62N and
`NOT_AUTHORIZED` at 52.27N, with the distance to the line stated.

## Two more defects, found by running it

**4. Coverage kilometres did not add up.** `round1` was applied on every
addition, so 13.7 km of route reported as 7.4 + 6.5 = 13.9. A dispatcher reading
coverage that does not sum to the route length has been given a reason to
distrust the whole screen. Fixed by accumulating raw and rounding once;
regression test uses awkward segment lengths and asserts the sum.

**5. The explanation printed `13.740481883557672 km`.** The returned field was
rounded, the sentence built from the raw accumulator. Fixed and pinned.

## Provenance note — an unauthored file

A second demonstration script, `scripts/demo-v22_17.ts`, appeared mid-session
and was not written here. It was reviewed against the invariants (it violated
none — it used the real procedures and invented no regulatory value), and then
**run**: its route endpoints fall in two disconnected components of the graph,
so it fails before reaching any communications output. That is the same defect
this build had already found and fixed. The verified script was moved into its
path and the duplicate at the repository root removed, so one demonstration
exists, in the right place, that actually runs. Nothing unauthored was shipped
as working, and nothing unverified is claimed here as mine.
