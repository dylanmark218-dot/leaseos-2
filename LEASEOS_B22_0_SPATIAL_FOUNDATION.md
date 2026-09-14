# LeaseOS — v22.0 Checkpoint: Spatial Foundation (routing source not loaded)

| | v21.21 | **v22.0** |
|---|---|---|
| Tables | 246 | **249** (+3; `locationIdentities` extended) |
| Migrations | 56 | **57** (`0058`; slots 0016/0017 remain reserved) |
| Role-authorized procedures | 342 | **353** (+11, `spatialRouter.ts`) |
| Externally-gated procedures | 33 | **33** |
| Integration-gated procedures | 2 | **2** |
| Bare `protectedProcedure` | 0 | **0** |
| Sensitive (fail-closed) | 86 | **89** (+3) |
| Tests | 1,434 | **1,441** (+7, `spatialFoundation.test.ts`) |
| Test files | 76 | **77** |
| Parity | 246/246 | **249/249 column-level** |
| CI gate | PASS | **PASS** |

Every count is read from the source.

---

## Existing code came first

The four-axis route evaluation with explainable, reproducible evidence, the
truck-routing request adapter with its weigh-station guard, the constraint
compiler, geofencing, bridges, and location identities were already here
from B11/B12. None is duplicated. v22.0 supplies what they consume and
exposes them; the routing *source* — P0 — is not here, and the system says
so on every request against the network.

## A coordinate says where it came from

An LSD is parsed from its common spellings to one canonical form and
refused outside the survey system (*LSD 17 is outside 1–16*, *Meridian W7 is
not W1–W6*); a UWI likewise. A location registered without a verified
coordinate sits on the **theoretical survey grid** — computed from the
Dominion Land Survey definition, sections and LSDs numbered boustrophedon
from the southeast corner — labelled `theoretical_grid`, confidence `low`,
carrying its caveat (*ignores correction lines, road allowances and
convergence; not for navigation*), and reported as **not navigable**. It
becomes navigable only when safety or management verifies it from **ATS
v4.1 with its dataset version** or a field GPS fix, with evidence; the
replaced theoretical position is named in the answer.

## Facts a route will be judged by are verified by a second person

A vehicle profile — height, width, length, empty weight, axle groups with
empty and loaded weights — is the shop's measurement or a spec sheet,
verified by the shop lead and never by the mechanic who recorded it; an
operator-stated profile is not verified. A road restriction is a rule row
with a source and a version, recorded unverified, verified by safety or
management against its source document; **nothing is seeded**.

## The four axes over named segments

The existing engine runs over segments the caller names, with the unit's
profile and the verified restrictions and bridges on those segments — **a
verified row over an unverified one per check, the latest within each**,
so an unconfirmed phone call does not displace a posted limit. The evidence
reads as a person would want it: *31500 kg exceeds 29000 kg on Clearwater
Creek bridge*, legal axis, authority-confirmed. An unverified restriction is
unknown data, not a pass; a check with no data is unknown; the verdict is
not clear. Every evidence line is persisted against the unit's profile in
the B12 evidence table, so the verdict can be reproduced.

## No routing source is loaded

A route against the road network answers **UNKNOWN**, with the reason and
*nothing was computed*, and the request is kept as a record of the ask. A
provider named in the environment is *configured, not implemented* — a key
in a variable never reads as routing. A test keeps Google Maps Platform
endpoints out of the server tree, so Places can never be combined with HERE
or Mapbox. The last position a machine reported is read as evidence with
its age and source, and the note that **a position is not a work state**.

---

## Corrected on the way

`check` is a MariaDB reserved word; the reserved-word audit refused it as a
column name before it shipped. It is `checkKey`, as in the B12 evidence
table.

## Files

**New:** `0058_spatial_foundation.sql` (3 tables; `locationIdentities`
extended) · `dls.ts` · `routingSource.ts` · `spatialRouter.ts` (11) ·
`spatialFoundation.test.ts` (7)

**Changed:** `recordsAuthorization.ts` (8 permissions, 3 sensitive, 11
mapped) · `routers.ts` · `schema.ts` · drift guards · inventory · generator

## Not built, and named — and blocked on a person

**P0** — no routing source. HERE Routing v8 is the recommended adapter for
Canada; Valhalla for offline. Neither is implemented; the reserved slots
0016/0017 wait for that tranche. **ATS v4.1** is not imported; coordinates
are verified one at a time with evidence. **Alberta 511 / DriveBC** feeds
are permission-blocked; the `roadRestrictions` rows they would fill exist
and are empty. PostGIS/Valhalla/Martin/MapLibre are not deployed. Offline
map packages and GPS route matching wait on all of the above.

## Blockers — unchanged

**P9** — no verified rule. **AER ST37 / ST102 / Alberta 511** — pending.
**P0/P5** — no routing source.
