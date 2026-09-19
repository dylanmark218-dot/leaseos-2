# LeaseOS Mapping, Commercial Routing, GPS & Live Job Tracking — design specification

**Status:** draft for owner approval. Written against `8a03803` (v23.09), after the source-neutrality
repair (`0164`) and before any OSM import. Nothing here is built yet except where marked
**ALREADY BUILT**, which means verified in the tree at this commit rather than believed.

---

## 0. The fact that shapes everything

The uploaded Alberta extract (`alberta-260910.osm.pbf`, verified here) contains:

| | count |
|---|---|
| highway ways | 734,600 |
| vehicle-road ways | 512,979 |
| Range Road named | 43,294 |
| Township Road named | 31,118 |

And the truck-limit tags on that vehicle subset:

| tag | count | | tag | count |
|---|---|---|---|---|
| `surface` | 268,989 | | `bridge` | 7,882 |
| `lanes` | 261,352 | | `maxheight` | 936 |
| `maxspeed` | 76,737 | | **`maxweight`** | **24** |
| `oneway` | 73,899 | | **`maxwidth`** | **23** |
| `hgv` | 14,934 | | **`seasonal`** | **15** |
| `hazmat` | 1,922 | | **`maxaxleload`** | **4** |
| | | | **`maxlength`** | **1** |

**0.005% of Alberta's roads carry a weight tag. One way in the province states a length limit.**

So the design's central premise is not "import the data and route on it". It is: *the topology is
excellent and the clearance data is absent, therefore UNKNOWN is the normal answer and the system
must be usable while that is true.*

Everything below follows from that.

---

## 1. What already exists (verified at `8a03803`)

Naming these matters because the previous architecture note referenced `commercialGraphRouting.ts`,
which is not in this tree. Building against a remembered filename is how a design ends up describing
a system nobody has.

| Concern | Module | State |
|---|---|---|
| Road graph / topology | `_core/roadGraph.ts` | **ALREADY BUILT** — `GraphSegment` / `GraphEdge`, now carrying source key, layer, feature id, version (`0164`) |
| Route evaluation | `_core/routeEvaluation.ts` | **ALREADY BUILT** — PASS / REVIEW / FAIL / UNKNOWN per check, with source, version, verifiedAt, confidence on every evidence entry |
| Source standing | `_core/legalLand.ts` | **ALREADY BUILT** (`0164`) — `ROAD_SOURCE_STANDING`, `standingFor()`, `roadAsSegment` |
| Import boundary | `_core/geoImport.ts`, `geoRouter.ts` | **ALREADY BUILT** for the Alberta ATS access-road layer |
| Geofencing | `_core/geofence.ts` | **ALREADY BUILT** — zone candidates, breadcrumbs, membership, transitions, confidence |
| GPS ingest | `_core/tripGps.ts` → `tripBreadcrumbs`, `zoneEvents` | **ALREADY BUILT** — a breadcrumb produces **proposed** events; `zoneEvents.state` is `pending / confirmed / rejected / expired` |
| Inter-engine status | `_core/interEngineStatus.ts` | **ALREADY BUILT** — PASS / REVIEW / BLOCKED / UNKNOWN / NOT_EVALUATED, never rounded up |
| Degradation suite | `_core/degradationSuite.test.ts` | **ALREADY BUILT** — every capability × every reason |

**The GPS→proposal boundary is therefore not new work.** It exists and is enforced by the schema:
a zone event is born `pending`. What this spec adds is the *structural guard* that no future write
path can bypass it — see §5.

---

## 2. Road truth: three layers, one canonical edge

```
  OSM Alberta PBF          Authority datasets         Live / field
  topology, class,         legal limits, bridges,     511 closures,
  names, surface,          road bans, DG routes       field observations
  access, oneway, hgv
        │                         │                        │
        └─────────────┬───────────┴────────────────────────┘
                      ▼
              CANONICAL ROAD EDGE          ← identity + geometry + source
                      │
                      ▼
               SEGMENT EVIDENCE            ← per check, per source, per version
                      │
                      ▼
               ROUTE EVALUATOR             ← PASS / REVIEW / UNKNOWN / FAIL
                      │
                      ▼
               APPROVED ROUTE              ← a person's decision, fingerprinted
```

**The PBF establishes that a road exists and how it connects. It establishes nothing about whether a
52,000 kg truck may use it.** That separation is already how `routeEvaluation` works; the import must
not blur it.

### 2.1 Source standing (**ALREADY BUILT**, `0164`)

| Source | ID prefix | Confidence | Jurisdiction |
|---|---|---|---|
| `ats_road_allowance` | `AB-ACCESS-` | `authority_confirmed` | `CA-AB` |
| `geofabrik_osm_ab` | `OSM-AB-` | `unverified` | `CA-AB` |
| unregistered | `<sourceKey>:` | `unverified` | **null** |

An unregistered source claims nothing, and null jurisdiction stays null — a caller's location is not
evidence of whose rules apply.

### 2.2 Absence semantics — the rule the whole import depends on

A missing OSM tag is **absent evidence**, not a value:

- **No** `maxWeightKg = null` column that somebody later reads as "no limit".
- **No** sentinel (`0`, `999999`).
- The check is declared **silent** for that segment, exactly as `roadAsSegment` already does for
  `road_weight_restriction`, `axle_group_limit`, `bridge_capacity`, `bridge_axle_limit`,
  `overhead_clearance`, `bridge_clearance` and width.
- The evaluator then answers **UNKNOWN** when the check applies to this vehicle.

This is **ALREADY BUILT** and tested. The import must add sources, never defaults.

### 2.3 What OSM *may* contribute as evidence

Only where the tag is a statement about the road rather than a legal limit, and always at
`unverified`:

| OSM tag | Contributes to | Standing |
|---|---|---|
| `surface`, `tracktype`, `smoothness` | `surface_condition` | unverified |
| `oneway` | direction | unverified |
| `access`, `motor_vehicle`, `hgv` | truck access candidacy → **REVIEW**, never PASS |
| `hazmat` | DG candidacy → **REVIEW**, never a DG routing clearance |
| `maxheight`, `maxweight`, `maxwidth` (the ~1,000 that exist) | the matching check → **REVIEW** |

**An OSM tag never produces PASS on a legal check.** It can raise a question; it cannot answer one.

---

## 3. Evidence coverage — making UNKNOWN readable

With 122 of 142 segments carrying no weight evidence, per-segment warnings are unusable: a driver
shown 122 yellow flags learns to dismiss yellow flags, and then dismisses the two that mattered.

So coverage becomes a **first-class route result**, per axis:

```
ROUTE DATA CONFIDENCE

Weight       ██░░░░░░░░  13%   REVIEW     19 verified · 1 unverified · 122 absent
Bridge       █████████░  91%   GOOD
Height       ████████░░  81%   GOOD
Width        ████░░░░░░  42%   REVIEW
Axle         ██░░░░░░░░  17%   REVIEW
Dangerous goods  █████████▌ 94%  GOOD
Seasonal     ███████░░░  67%   REVIEW
```

Dispatch drills into the absent segments; the driver sees one number per axis.

**Store the coverage figures on the route decision.** `routeEvidenceEntries` already carries source,
version, verifiedAt and confidence per check, so the numbers are derivable today — but derivable
*now* is not the same as answerable *later*. When coverage rises from 13% to 60%, "why did we approve
this in March" must still resolve to March's 13%.

*(Checkpoint of its own — not part of the import.)*

---

## 4. Precedence: what wins when sources disagree

**Asymmetric, and the asymmetry is the point.**

```
posted / controlling road authority
        ↓
official verified restriction
        ↓
verified operator instruction
        ↓
confirmed LeaseOS field hazard
        ↓
OSM / general map data
```

Plus one overriding rule:

> **A source may always make a segment less trusted. It may never make a segment more permissive
> than the evidence above it.**

| 511 says | Driver reports | Result |
|---|---|---|
| OPEN | bridge washed out | **BLOCKED / REVIEW** — a credible hazard stops the route pending investigation |
| CLOSED | "looks open to me" | **STILL CLOSED** — a field report cannot lift an official restriction |
| UNKNOWN | road is fine | **UNKNOWN** — an unverified clearance is not a clearance |

This is the same rule `routeEvaluation` already applies on one axis (a limit satisfied on unverified
data answers `review`, not `pass`), extended to a second.

---

### 4.1 Built (v23.14) — `_core/sourcePrecedence.ts`

Owner-approved 2026-09-19. `AUTHORITY_RANK`: posted road authority → official restriction →
operator instruction → LeaseOS field hazard → open map data. Restrictiveness order: open → unknown
→ restricted → closed.

**Anything may tighten; nothing may loosen below the highest-ranking source.** The asymmetry is the
rule, and the two directions carry different consequences: a driver reporting a washed-out bridge
describes something he can see — believing him costs a detour, disbelieving him costs a truck. A
driver reporting that a closed road "looks fine" describes the *absence* of something, and the
absence of a visible reason is not evidence that the reason is absent: the closure may be a load
restriction, a permit condition, or work starting tomorrow.

A **credible safety-negative observation acts before verification** — waiting for corroboration on a
reported washout means the next truck drives at it. It is temporary by construction: it names the
authority that can lift it, and lifting takes that path rather than the passage of time. An
unattributed report raises nothing; there is nobody to ask.

Conflicts are **kept and surfaced**, never settled by arrival order — the same two claims resolve
identically either way round, asserted. `server/_core/sourcePrecedence.test.ts` (11 cases).

**Not mounted:** where a field observation enters the attribute stream is M3's evidence compiler,
not a wiring choice.

## 5. GPS: evidence, never job state

**ALREADY BUILT:** a breadcrumb produces `proposedEvents`; `zoneEvents.state` is
`pending | confirmed | rejected | expired`.

**To add — the structural guard.** The rule currently holds because the code happens to be written
that way. It needs to be impossible to bypass:

```
GPSFix ──► deriveSpatialProposal() ──► zoneEvent(pending) ──► confirm ──► TripEvent
   │                                                                        ▲
   └────────────────────────── FORBIDDEN ───────────────────────────────────┘
```

A guard fails if any production write path turns a fix or a zone inference into a trip-state
transition without passing the confirmation boundary. Same shape as the guard that stops a `values()`
choosing columns by automation mode.

GPS **may** establish: position, distance-to-site, geofence crossing, route deviation, connectivity
gap.
GPS **may not** establish: loading, unloading, standby, customer hold, disposal accepted, job
complete.

> GPS entered the North Pad arrival geofence at 07:33:46 (±7 m). **Driver confirmed arrival 07:34.**

Two facts, both recorded, neither pretending to be the other.

---

## 6. The four permission gates for phone location

1. **Device authority** — the device belongs to an authenticated user
2. **Monitoring notice** — issued *and acknowledged* (these are separate; `0160` keeps them so)
3. **OS permission** — the platform granted location access
4. **Active work scope** — there is a live trip that authorizes collection

**Owner decision required (§10.1):** a missing acknowledgement should block *personal-phone
monitoring*, not block *work*. If the job's location stream can come from truck telematics, dispatch
proceeds and the phone simply does not collect.

When the trip closes: active trip `NONE`, operational GPS streaming `OFF`. Not a background employee
tracker that happens to be quiet.

---

## 7. One stream, four projections

| Audience | Sees |
|---|---|
| **Driver** | exact position, approved route, next instruction, restrictions, 511 state, access/gate, radio plan, job stage, documents |
| **Dispatch** | exact fleet positions, assignment state, ETA, deviation and stale-route alerts, readiness blockers |
| **Office** | trip progress, timestamps, mileage, route evidence, waiting time, ticket/document state, billing evidence |
| **Client** | their job only: stage, ETA, load progress, delays, documents |

### 7.1 The customer projection is a type, not a filter

```ts
CustomerTripProjection {
  jobRef; state; eta; progress; loadsCompleted; loadsPlanned;
  delayCategory; approximateProgress; lastUpdatedAt;
}
```

**No `latitude: null`. No `driverName: null`.** A nulled field proves the concept exists in the
payload and invites the next person to populate it. The sensitive fields must not be in the returned
type at all.

This must be built **early**, with the intermediate types — not retrofitted at M9, by which point
every layer beneath already carries the shape.

**Owner decision required (§10.2):** exact position is never derived from a driver's personal phone.
If a contract requires live asset tracking, the source is truck telematics and it is a separately
permissioned commercial feature.

---

## 8. Alberta 511 — build the gate closed

511 licensing is unresolved (**P6.3**, blocking **P2.2**). The adapter and the refusal are built
now; ingestion stays off.

```
Alberta511Provider
   ├── rights recorded?  NO  → PROVIDER_DISABLED, reason recorded
   └── YES → retrieve → normalize → map-match → dynamic restrictions
```

Downstream reads `live_511_state = unavailable_due_to_rights` — **not** `clear`. Building the gate
first means 511's absence is a visible state rather than an assumption baked into eight layers that
each quietly assume it is coming.

When it is licensed, the chain is:

```
511 ingest → normalize → map-match → dynamic restriction on segment D
   → route.restriction_changed → fingerprint invalid → route STALE
   → dispatch assignment AT RISK → candidate reroute → human approval
```

Dispatch eligibility already treats a route decision as a dependency and invalidates on material
change. That machinery is reused, not rebuilt.

---

## 9. Build order

| | Tranche | Why here |
|---|---|---|
| **M1** | Source & licence gates, **plus the GPS and customer boundaries** | 511 closed; OSM provenance; **and the projection/proposal types**, because both are type decisions that contaminate every later layer if made late |
| **M2** | PBF importer → canonical directed edges, raw tags preserved, topology validated | |
| **M3** | Evidence compiler: OSM attributes + authority restrictions + observations + overlays → one segment evidence model | |
| **M4** | Coverage metrics, persisted on the route decision | |
| **M5** | Routing: candidate generation, truck/load evaluation, fingerprints | |
| **M6** | Job / dispatch binding: job, trip, unit, load, driver, approved route, readiness | |
| **M7** | Mobile / offline: MapLibre tiles, region + corridor packages, GPS queue, map matching, sync | |
| **M8** | Live restriction reaction: changed → stale → AT RISK → reroute → approval | |
| **M9** | Dispatch, office and client UI — same trip, three projections | |
| **M10** | Field validation on known Alberta heavy-haul and back-road routes | |

**Change from the earlier proposal:** GPS and customer boundaries move from M4 into **M1**. The
argument for it is the proposal's own: a `CustomerTripProjection` must not contain `latitude: null`.
That is a decision about types, and M2/M3 build the types.

### 9.1 Map tiles are not the road graph

Two artefacts, never conflated:

- **Tiles** = what the driver sees (MapLibre, offline packages: province base → operating region →
  active trip corridor)
- **Graph** = what LeaseOS calculates with (canonical edges + evidence)

The 680 MB GeoPackage feeds display, search and POIs. It is not a routing authority.

---

## 10. Owner decisions — APPROVED 2026-09-19

**10.1 Missing monitoring acknowledgement — APPROVED.** It blocks personal-phone monitoring, not
employment and not dispatch. Where a job independently requires a live location stream and no
authorized source supplies one, readiness may answer REVIEW/BLOCKED — **for the missing capability,
never as a consequence of declining personal-phone monitoring**. Closing the trip ends collection.
Issued and acknowledged stay separate facts.

**10.2 Exact customer position — APPROVED.** Never originates from a driver's personal phone. The
customer projection carries stage, ETA, approximate progress, loads, delay status, business events
and last update — and **no latitude/longitude, no driver identity, and no nulled location fields**,
because a nulled field proves the concept exists. Exact asset tracking, if ever contracted, is a
separate feature on an approved asset source with its own entitlement, purpose, retention and
projection boundary.

**10.3 Source precedence — APPROVED** as §4's asymmetric rule. A lower-authority or field source may
make a segment **less** permissive, never more. Official OPEN + credible washout → BLOCKED/REVIEW.
Official CLOSED + "looks open" → CLOSED. UNKNOWN + "looks clear" → UNKNOWN. Conflicting evidence is
preserved and surfaced, never settled by arrival order.

**10.4 Coverage and second approval — APPROVED WITH CHANGE. Not a percentage.**

A threshold would have been the wrong design and the dataset is why: **24 `maxweight` tags across
512,979 vehicle-road ways**. Verified weight coverage on an ordinary Alberta back-road route starts
near zero, so "under 70% needs two signatures" would demand a second approver for every load in the
province — and a signature given hundreds of times a week is a keystroke, not a control.

So the two ideas are separated, and **`_core/routeApprovalPolicy.ts` implements the split**
(`server/_core/routeApprovalPolicy.test.ts`, 9 cases):

- **Coverage is evidence.** Per axis, persisted on the approval by `0165`, never a gate. Stored
  rather than re-derived so a route approved at 13% still reads 13% after the data reaches 60%.
- **Risk is the trigger.** A second approver is required for a **specific** unresolved
  high-consequence fact on a road this route uses — an unrated bridge it crosses, a clearance
  resting on unverified evidence, two authorities disagreeing. "Alberta has not published weight
  limits" is a fact about Alberta, not about this route, and never triggers.
- **A FAIL is nobody's to sign.** Carried separately from the triggers and reported first: a second
  approver is permission to proceed on what nobody could establish, not on what was established as
  false.

### 10.5 The FAIL rule, enforced where approvals are written (v23.13)

10.4 says a known FAIL remains a FAIL and no second signature clears it. The policy core answered
that correctly from the day it was written. The **procedure** did not: its one refusal read
`input.dispatchStatus`, a free-form string the caller supplies, so the rule protecting route
approval checked what the caller *said* about the route rather than what the evaluation *found*.
Approving a failing route needed nothing more than sending `"review"`.

Not an exploit — a caller assembling its input from a stale verdict does it by accident, and the
approval looks ordinary afterwards. `spatial.approveRoute` now reads `routeEvidenceEntries` for this
route's own segments and refuses on any stored `fail`, naming the segment, the check and the reason.
The caller-supplied check is kept as well: a caller that correctly reports `blocked` is still
refused before a database read, and the evidence check is what makes the rule true when it does not.

---

### 10.1 / 10.2 — BUILT (v23.15)

`_core/phoneLocationGate.ts` implements the approved §10.1: **no acknowledgement, no personal-phone
monitoring — which is not the same as no work.** `monitoringNotice.ts` had deliberately stopped
short of this, its own comment naming it owner policy.

Two questions kept apart on purpose. *May this phone stream?* needs an acknowledged
`vehicle_location` notice and an active trip, and a **withdrawal is named as a withdrawal** rather
than as a lapse, so nobody chases an acknowledgement a person revoked. *Does the job need a stream,
and is one available?* prefers a company source over the handset wherever one exists — not because
the phone is worse data, often it is better, but because the truck belongs to the employer and the
handset does not, and a system that reaches for the personal device first will keep reaching for it.

When the job requires a stream and none exists, the answer is a **missing capability**
(`live_location_stream_unavailable`) with the driver's decision nowhere in the reason. That is
guarded, not merely intended: a blocker reading "driver declined monitoring" turns a privacy choice
into a performance record, and once dispatch can see who declined, the decline becomes the thing
being managed rather than the missing device.

§10.2's *hidden/null location field* rule is guarded too — `customerProjections.ts` carries no
coordinate or driver-identity field in any form. The nulled form is the one worth catching: a
`latitude: null` proves the concept exists in the shape, and the next person who needs a coordinate
fills it in rather than asking whether they may. `server/_core/phoneLocationGate.test.ts` (14 cases).

---

## 11. What this specification deliberately does not do

- **It does not redesign UNKNOWN / silent checks.** That behaviour is correct and tested.
- **It does not adopt GraphHopper, HERE or Valhalla as the router.** A provider adapter is a
  reasonable future option for comparison; whatever finds a path, the LeaseOS evaluator decides
  whether that path may be used. Finding a route is not permission to drive it.
- **It does not import anything yet.** The boundary is source-safe as of `0164`; the importer is M2.

### 10.4 addendum — evidence binding (BUILT, v23.17, `0167`)

`0165` freezes what was known at approval time as **numbers**. The **detail** behind them lives in
`routeEvidenceEntries` — source, version, verifiedAt, confidence per check per segment — and those
rows were tagged only with trip, job and segment. A trip evaluated three times left three
indistinguishable sets, so "the evidence this approval rests on" had no answer.

Resolved as identity rather than policy: each evaluation mints an `evaluationRef`, every evidence
row it writes carries it, and an approval records the one it was made from. A later re-evaluation
writes a new set under a new ref and leaves the approved set untouched — the same reasoning as
`0159` storing an axle determination rather than re-deriving it.

**An approval with no named evaluation stores null.** Inferring the most recent evaluation would
attach evidence to an approval that may never have seen it, which is the false precision this
removes. Historical rows stay null and read as unattributable, because that is what they are.

### Source coverage — British Columbia added (v23.18)

`geofabrik_osm_bc` registered: `OSM-BC-`, `unverified`, jurisdiction **`CA-BC`** — the first source
to exercise `0164`'s jurisdiction-from-source rather than the constant it replaced. A BC road
evaluated under Alberta's limits would be a quiet, confident wrong answer.

Measured on `british-columbia-260918.osm.pbf` (1.25 GB):

| | Alberta | British Columbia |
|---|---|---|
| vehicle ways | 512,979 | 490,986 |
| `maxweight` | 24 | 108 |
| `maxaxleload` | 4 | 5 |
| `maxheight` | 936 | 988 |
| **`maxwidth`** | 23 | **0** |
| `maxlength` | 1 | 14 |
| bridges mapped | 7,882 | 10,157 |
| back-road names | 43,294 Range Rd · 31,118 Township Rd | 7,180 Forest Service Road |
| `ford` | — | 113 |

**Not one width restriction in British Columbia**, in the province whose Forest Service Roads are
where a wide load actually gets stopped. And 10,157 bridges of which roughly **one percent** state a
capacity. §0's conclusion holds harder here than in Alberta: OSM establishes where a road is and how
it connects, and nothing about whether this truck may use it.

`ford` is new — 113 water crossings BC tags and Alberta barely has. Worth a check key of its own
when the importer lands; a ford is a real constraint for a loaded unit, not a surface quality.
