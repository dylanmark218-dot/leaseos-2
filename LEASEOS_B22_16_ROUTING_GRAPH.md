# LeaseOS — v22.16 Checkpoint: The First Routing Graph

| | v22.15 | **v22.16** |
|---|---|---|
| Tables | 261 | **264** (`roadGraphBuilds`, `roadGraphNodes`, `roadGraphEdges`) |
| Migrations | 71 | **72** (`0073`) |
| Role-authorized procedures | 393 | **395** (+2) |
| Sensitive (fail-closed) permissions | 101 | **102** |
| Bare `protectedProcedure` | 0 | **0** |
| Tests | 1,522 | **1,527** (+5, `roadGraph.test.ts`) |
| Test files | 88 | **89** |
| Parity | 261/261 | **264/264 column-level** |
| CI gate | PASS | **PASS** |

---

## P0, partially lifted — and precisely how far

**Routing now works inside the areas a person has imported and built.
Everywhere else the answer is unchanged: no graph, no route.** That is the
whole claim, and the procedure says it in those words rather than failing
vaguely.

## The measurement that decided the design

Before writing a graph I checked whether Alberta's road data actually
connects. Across 293 segments in one township:

```
299 distinct endpoints · 154 shared by two or more segments
440 endpoint-to-endpoint joins · 1 T-junction
9 components · largest 215 of 293 segments
```

Endpoints match to seven decimal places. Alberta's layer is **properly
noded**, so an endpoint-joined graph is the correct model and edge-splitting
at T-junctions is a refinement, not a prerequisite. Had that measurement come
back differently, this would have been a different piece of code.

## What was built

A graph build is a **recorded artefact**: the box, the snap tolerance, the
segments considered, the routable edges, nodes, components, isolated edges,
the surfaces excluded, and the import runs it stands on. A route can name the
graph it was computed on, and when the graph is rebuilt a v22.15 route
approval goes stale by fingerprint.

**A driveway, ferry or ford is never routable** — a driveway is somebody's
yard, and the other two are not roads. Dijkstra runs over a surface-weighted
cost where a kilometre of dry-weather road costs 1.8 km of pavement, and the
weighting is stated rather than hidden in a score.

**The two questions stay separate.** This module answers *what roads connect
A and B* and never *may this truck drive them*. A computed path is handed
straight to the four-axis evaluator, so:

```
GRAPH  293 segments considered → 246 routable edges, 253 nodes,
       8 components (largest 175), excluded driveway/ferry/ford
ROUTE  evaluated: 25 segments, 13.7 km — 0.82 km paved, 12.93 km gravel
       via Grande Prairie Trail Road
VERDICT  warning · legal unknown · unknown 50 · failing 0
```

A real 13.7 km route across live Alberta geometry, and still **not clear to
dispatch** — because 50 limits remain unstated by the province. A path is a
proposal, never a permission.

Honest outcomes throughout: `no_graph`, `origin_unreachable`,
`destination_unreachable`, `disconnected` (with both component ids),
`path_only` when no vehicle was supplied, `evaluated`. Every path reports its
snap distance, because the last stretch from the road to a lease entrance is
not part of the road network.

## Corrected on the way

The graph auto-selection took whichever covering build came first — with
several current builds over one area, a **stale graph could win**. The newest
covering graph now wins deterministically. And an authorization edit landed
in the dispatcher's role array and then the procedure map instead of the
sensitive-permission list, because `"geo.access.decide"` appears in all
three; it cost several attempts and is a standing lesson about anchored
string edits in that file. `geo.graph.build` is now sensitive, held by
management and controller only.

## Files

**New:** `0073_road_graph.sql` · `_core/roadGraph.ts` · `roadGraph.test.ts` (5)

**Changed:** `geoRouter.ts` (+2 procedures) · `schema.ts` ·
`recordsAuthorization.ts` · two count pins · truth guard · inventory ·
generator

## Not built, and named

**A provincial graph** — this routes one township because that is what has
been imported; the OSM/Geofabrik import (333 MB, ODbL, commercial use
permitted) is what scales it, and PostGIS earns its place at that point, not
before. Edge-splitting at T-junctions (measured: one in 293). Turn
restrictions, one-ways and turning radius — the access-road layer states
none. Alternate-route candidates and the RECOMMENDED / SAFER / SHORTEST
comparison. Breadcrumb-derived route learning. Automatic re-evaluation when
an approval goes stale. Offline route packs and tiles.

## Blockers

**P0** — now scoped: lifted inside built areas, standing outside them.
**AER ST37 / ST102** — written permission for commercial use.
**Alberta 511** — API key. **P9** — no verified rule.
