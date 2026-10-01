# LeaseOS External Data Source Registry

**Verification completed 2026-09-09; Canadian 511 tranche checked 2026-09-24.**
Every field below was checked against the publisher and is now seeded into
`externalDataSources` by `seedExternalDataSources()`. This document describes
what the runtime enforces; it is not the enforcement itself.

## Ten verified, twenty-five not

| | Count |
|---|---|
| Verified — usable per their licence | **10** |
| Unverified — inspection only | **25** |
| Total | **35** |

> **Correction.** The research summary stated "nine of eleven are clean" while
> separately flagging three as unresolved. Eleven minus three is eight. Seeding
> nine would have marked a blocked source usable. `externalSourceSeeds.test.ts`
> holds the counts — now 10 / 25 / 35 after the transport tranche and later
> inspection-only catalogue candidates below.

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
| `on511` | Ontario MTO | OGL – Ontario | yes | yes | no |
| `qc_mtmd_roadworks` | Québec MTMD | CC BY 4.0 | yes | yes | no |

## Unverified — blocked for everything but inspection

| Key | Why blocked |
|---|---|
| `aer_st37` | AER Terms of Use, not an open licence. Commercial use and redistribution **unknown**. |
| `aer_st102` | Same. |
| `ab511` | Developer terms via account registration. No open licence stated. Commercial use and redistribution **unknown**. |
| `mb511` | Manitoba 511. Same platform as Alberta: key and throttle documented, no licence on the Developer Resources page. **Unknown**. |
| `nb511` | New Brunswick 511. Same. **Unknown**. |
| `yt511` | 511 Yukon. Same. Publishes weight and bridge restrictions, so its answer matters most. **Unknown**. |
| `nl511` | 511 Newfoundland and Labrador. Same. **Unknown**. |
| `sk_highway_hotline` | Saskatchewan Highway Hotline. No developer API published; the website is not scraped. Access request drafted in `docs/P6_DATA_PERMISSION_REQUESTS.md` §4. |
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
| `tc_vehicle_recalls` | Transport Canada Vehicle Recalls Database, last 60 days, daily. Catalogue states OGL – Canada; not yet reviewed. A match is information for a person, never a safe/unsafe determination. |
| `hc_recalls_safety_alerts` | Government of Canada Recalls and Safety Alerts feed. Catalogue states OGL – Canada; not yet reviewed. |
| `goc_open_data_api` | The federal CKAN catalogue. Catalogue states OGL – Canada for itself; each dataset it lists is its own source with its own licence. |
| `statcan_wds` | Statistics Canada Web Data Service. Statistics Canada Open Licence named; not yet reviewed. |
| `statcan_rdaas` | Statistics Canada Reference Data as a Service. Same licence named; not yet reviewed. |
| `bc_data_catalogue` | BC's CKAN catalogue. Licensing is per dataset and not uniformly OGL – BC, so the row names no licence. |
| `qc_reseau_camionnage` | Québec heavy-truck network (a different dataset from the cleared `qc_mtmd_roadworks`). Données Québec lists CC BY 4.0; the attribution wording is recorded on review. |

Every one carries `attributionText: null` deliberately, as a second barrier: a
source cannot reach operational use by editing `status` and the permission flags
alone — somebody has to have actually recorded what the publisher requires shown.
Test-pinned.

**Required to unblock:** written confirmation from AER (Terms of Use) and from
Alberta, Manitoba, New Brunswick, Yukon and Newfoundland-and-Labrador 511
(developer terms) covering (a) commercial fleet use and (b) offline
redistribution to field tablets. Saskatchewan Highway Hotline still needs a
published API or written permission path. For the seven 2026-09-24 catalogue
candidates a reviewer reads the named licence and records its attribution. None
needs a written request unless that reading leaves commercial fleet use
unclear.

## Integration states

`integrationState()` gives each source one of four states for integration
planning. It adds no second rule: it labels what `evaluateSourceUsage` already
decides for `operational_decision`, and a test checks that the two agree for
every seeded source.

| State | Meaning | Today |
|---|---|---|
| `APPROVED_FREE_COMMERCIAL` | Cleared for commercial use, no attribution owed | none |
| `APPROVED_WITH_ATTRIBUTION` | Cleared for commercial use; show the attribution text | the 10 verified |
| `PERMISSION_REQUIRED` | Unreviewed, commercial terms unknown, or attribution unrecorded | the 25 unverified |
| `DO_NOT_USE` | Withdrawn, superseded, or commercial use recorded as not permitted | none |

"Approved" answers commercial use only. Offline bundling and redistribution
are still decided per intent by the gate, and an advisory-only source
(`cwfis`) stays advisory.

**Clearing a candidate** is `geo.sourceReview` with the licence the reviewer
read, the attribution text it requires, and what it permits. The research that
named each licence is not a review.

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
- Contains information licensed under the Open Government Licence – Ontario
- Source : ministère des Transports et de la Mobilité durable du Québec, via Données Québec, sous licence CC BY 4.0 — données normalisées par LeaseOS
- Contains data provided by Environment and Climate Change Canada

`collectAttributions()` deduplicates these and **names any source missing
required attribution** rather than skipping it.

## Canadian road-information providers

The per-province matrix is in
[`docs/transport/CANADIAN_PROVIDER_MATRIX.md`](docs/transport/CANADIAN_PROVIDER_MATRIX.md): what
each publisher offers, whether it needs a key, its licence, and LeaseOS's status. It covers every
province and territory, including Nova Scotia, PEI, the Northwest Territories and Nunavut, which
are surveyed there and not registered here. How a collected event reaches an approved route is in
[`docs/transport/CANADIAN_PROVIDER_RUNTIME.md`](docs/transport/CANADIAN_PROVIDER_RUNTIME.md).

This file stays the licence record per source key, and the tables above are the authority for each
key's licence and verification. In short: `drivebc_open511`, `qc_mtmd_roadworks` and `on511` are
cleared. Ontario still needs a developer key on the server. The other five 511s are blocked for
rights, and Saskatchewan publishes no feed. Clearing a source is not the same as collecting from it:
no feed is enabled in production.

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

No provincial road feed is collected in production either. The collection runtime is built and
tested against a real database (`server/transportFeedRuntime.ts`), and nothing schedules it. Where
the recurring tick runs is an owner decision, set out in `docs/transport/CANADIAN_PROVIDER_RUNTIME.md`.
