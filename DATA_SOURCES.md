# LeaseOS External Data Source Registry

**Verification completed 2026-09-09.** Every field below was checked against the
publisher and is now seeded into `externalDataSources` by
`seedExternalDataSources()`. This document describes what the runtime enforces;
it is not the enforcement itself.

## Eight verified, thirteen not

| | Count |
|---|---|
| Verified — usable per their licence | **8** |
| Unverified — inspection only | **3** |
| Total | **11** |

> **Correction.** The research summary stated "nine of eleven are clean" while
> separately flagging three as unresolved. Eleven minus three is eight. Seeding
> nine would have marked a blocked source usable. `externalSourceSeeds.test.ts`
> now holds the counts at 8 / 3 / 11.

## Verified sources

| Key | Authority | Licence | Commercial | Redistribute | Share-alike |
|---|---|---|---|---|---|
| `osm` | OSM Foundation | ODbL v1.0 | yes | yes | **YES** |
| `nrn` | NRCan / StatCan | OGL – Canada | yes | yes | no |
| `canvec` | NRCan | OGL – Canada | yes | yes | no |
| `ats` | Alberta PGC | OGL – Alberta | yes | yes | no |
| `ats_road_allowance` | Alberta PGC | OGL – Alberta | yes | yes | no |
| `drivebc_open511` | BC MoTI | OGL – BC | yes | yes | no |
| `msc_geomet` | ECCC | ECCC End-use Licence | yes | yes | no |
| `cwfis` | NRCan CFS | OGL – Canada | yes | yes | no |

## Unverified — blocked for everything but inspection

| Key | Why blocked |
|---|---|
| `aer_st37` | AER Terms of Use, not an open licence. Commercial use and redistribution **unknown**. |
| `aer_st102` | Same. |
| `ab511` | Developer terms via account registration. No open licence stated. Commercial use and redistribution **unknown**. |
| `aer_st107` | Well and facility licence status. AER Terms of Use, not an open licence. The directory stores the WM approval number and links out; mirroring is **unknown** pending the written answer requested in `docs/P6_DATA_PERMISSION_REQUESTS.md` §2. |
| `sk_iris` | Believed to be published under a standard unrestricted use licence, and believed is not recorded. Confirmation requested (§3); **unknown** until it arrives. |
| `mb_petroleum` | Same question, second province (§3). **Unknown**. |
| `ised_b1_western` | ISED's western and northern mobile appendix. Published openly; redistributing it to field tablets as an operational channel bank is a different question and was not confirmed. |
| `ised_bc_rr` | ISED's BC resource-road channel conditions. Same question, and the publisher states the channels are for use where posted. |
| `ised_cb_grs` | RSS-236, the General Radio Service allocation. Same. |
| `ised_sms` | Spectrum Management System licence extracts — licence holders, sites and call signs. Personal and corporate licence data; redistribution terms not confirmed. |
| `bc_resource_road_maps` | The province states these are planning tools and that the posted road sign takes precedence. |
| `statcan_boundaries` | The provincial/territorial boundary file. Licence not reviewed here, so nothing imports from it — which is exactly why a coordinate still cannot establish a province. |
| `crtc_coverage` | Modelled coverage layers published for regulatory purposes, not a guarantee of service at a position. |

All ten carry `attributionText: null` deliberately, as a second barrier: a
source cannot reach operational use by editing `status` and the permission flags
alone — somebody has to have actually recorded what the publisher requires shown.
Test-pinned.

**Required to unblock:** written confirmation from AER (Terms of Use) and from
Alberta 511 (developer terms) covering (a) commercial fleet use and (b) offline
redistribution to field tablets.

## Caveats the code carries

- **`osm`** — share-alike attaches to a **Derivative Database**. An offline
  extract bundled to a tablet *is* a Derivative Database; the rendered map is a
  **Produced Work** needing attribution only. Keep the OSM-derived routing
  database logically separable from proprietary layers.
- **`ab511`** — ten calls per sixty seconds, verified verbatim. Poll into a
  central cache; **never proxy the raw API to devices**.
- **`aer_st37`** — shapefile is being retired in favour of File Geodatabase
  after a three-month transition. Ingest FGDB.
- **`cwfis`** — the publisher states it is *not designed for operational fire
  management*. Registered `ADVISORY_ONLY`: it may add context to a screen and may
  never satisfy a safety constraint. Licence permits use — advisory is about
  fitness, not permission.
- **`msc_geomet`** — no `no-cache` headers, no bulk WMS-tile scraping,
  descriptive User-Agent, roughly one request per second.
- **`ats`** — base survey grid with no publisher-stated refresh cadence, so
  `updateIntervalHours` is null and freshness resolves to `unknown` rather than
  being assumed fresh.

## Attribution owed

Rendered wherever the data appears:

- © OpenStreetMap contributors
- Contains information licensed under the Open Government Licence – Canada
- Contains information licensed under the Open Government Licence – Alberta
- Contains information licensed under the Open Government Licence – British Columbia
- Contains data provided by Environment and Climate Change Canada

`collectAttributions()` deduplicates these and **names any source missing
required attribution** rather than skipping it.

## Software components — a separate registry

Deliberately not in `externalDataSources`. A software licence and a data licence
create different obligations, and `evaluateSourceUsage` asks data questions —
whether a layer may be redistributed, whether it is fresh enough to satisfy a
constraint. Those are meaningless about GDAL. Mixing them would let the gate
return confident nonsense.

| Component | SPDX | Caveat |
|---|---|---|
| MapLibre GL JS | BSD-3-Clause | — |
| MapLibre Native | BSD-2-Clause | FreeType notice. **Kept separate from GL JS** — different licences. |
| Valhalla | MIT | Truck costing accepts height, width, length, weight, axle_load, axle_count, hazmat |
| Martin | Apache-2.0 OR MIT | — |
| Pelias | MIT | — |
| GDAL/OGR | MIT | A build can link GPL/LGPL deps — verify the build shipped |
| Turf.js | MIT | — |
| PostGIS | GPL-2.0-or-later | Copyleft applies to modifying and distributing PostGIS itself. Do not fork it into the product. |

All eight are usable in a closed-source commercial product.

## Still not done

No dataset has been imported. No PostGIS, Valhalla, Martin or MapLibre component
has been deployed. This tranche made the verification machine-enforced; the
import itself is P5 and remains gated on the reserved Spatial branch.
