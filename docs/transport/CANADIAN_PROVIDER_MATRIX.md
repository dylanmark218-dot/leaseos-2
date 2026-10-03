# Canadian provider matrix

This is the canonical list of which provinces and territories publish road information, under what
terms, and where LeaseOS stands on each. `DATA_SOURCES.md` holds the licence record per source key
and points here. [`CANADIAN_PROVIDER_RUNTIME.md`](CANADIAN_PROVIDER_RUNTIME.md) explains how a
collected event reaches a route.

**Evidence.** AB, BC, SK, MB, ON, QC, NB, NL and YT were read from each publisher's developer page
on 2026-09-24. Ontario's key requirement, the 511 platform's `400 Invalid Key` answer, and the
absence of `ETag`/`Retry-After` headers were rechecked on 2026-10-01. NS, PEI, NWT and Nunavut, plus
the Québec reconfirmation, were surveyed on 2026-10-01 for this checkpoint. Anything not verified on
an official page is marked *unverified*.

**Key vs licence.** *Needs a key* is about whether LeaseOS can call the API. *Licence* is about what
LeaseOS may do with the answer. Only the licence opens the gate.

## Where LeaseOS stands

| Jurisdiction | Source key | Feed | Needs a key | Licence | Commercial use | LeaseOS status |
|---|---|---|---|---|---|---|
| Alberta | `ab511` | 511 platform | yes, `AB_511_API_KEY` | none published | unknown | **rights review**, adapter built |
| British Columbia | `drivebc_open511` | Open511 | no | OGL – BC | yes | cleared, adapter built, **not enabled** |
| Saskatchewan | `sk_highway_hotline` | none published | — | none published | unknown | **no published API**, never scraped |
| Manitoba | `mb511` | 511 platform | yes, `MB_511_API_KEY` | none published | unknown | **rights review**, adapter built |
| Ontario | `on511` | 511 platform | **yes**, `ON_511_API_KEY` | OGL – Ontario | yes | cleared, adapter built, **waiting on a key** |
| Québec | `qc_mtmd_roadworks` | MTMD WFS | no | CC BY 4.0 | yes | cleared, adapter built, **not enabled** |
| New Brunswick | `nb511` | 511 platform | yes, `NB_511_API_KEY` | none published | unknown | **rights review**, adapter built |
| Newfoundland and Labrador | `nl511` | 511 platform | yes, `NL_511_API_KEY` | none published | unknown | **rights review**, adapter built |
| Yukon | `yt511` | 511 platform | yes, `YT_511_API_KEY` | none published | unknown | **rights review**, adapter built |
| Nova Scotia | — | 511 platform, undocumented | yes (`400 Invalid Key`) | site terms: **non-commercial** | no / unknown | **not registered**, see below |
| Prince Edward Island | — | 511 platform, undocumented | yes (`400 Invalid Key`) | none published | unknown | **not registered**, see below |
| Northwest Territories | — | none (DriveNWT is map-only) | — | GNWT terms: commercial use needs written consent | no, without consent | **no published feed** |
| Nunavut | — | none | — | — | — | **not applicable**: no highway network or feed found |

"Not enabled" and "waiting on a key" are owner actions. "Rights review" waits on a written answer:
`docs/P6_DATA_PERMISSION_REQUESTS.md` §6.

## What each publisher offers

✓ = listed on the publisher's developer page or dataset. — = not offered. ? = unverified.
Read = an adapter exists today. The adapters read events only; everything else is recorded here so
the gap is visible.

| | Conditions | Closures | Construction | Weight | Bridges | Seasonal | Ferries | Cameras | Rest areas | Inspection | Format | Rate limit |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| AB `ab511` | ✓ | ✓ events | ✓ events | ? | ✓ | ✓ road bans (site) | ✓ | ✓ | ✓ | ✓ | JSON/XML | 10 / 60 s |
| BC `drivebc_open511` | ✓ (read) | ✓ (read) | ✓ (read) | — | — | — | — | — | — | — | JSON | none published |
| SK | ? (site only) | ? | ? | ? | ? | ? | ? | ? | ? | ? | — | — |
| MB `mb511` | ✓ | ✓ events | ✓ events | — | — | ✓ winter roads | — | ✓ | — | — | JSON/XML | 10 / 60 s |
| ON `on511` | ✓ | ✓ (read) | ✓ (read) + construction projects | ✓ seasonal loads | — | ✓ seasonal loads | ✓ | ✓ | ✓ truck rest areas | ✓ | JSON/XML | 10 / 60 s |
| QC MTMD | ✓ winter conditions | ✓ `avertissement-routier` | ✓ (read) `travaux-routiers` | ✓ CC BY-ND | ✓ `structure` | ✓ `zone-de-degel` | ✓ `liaison-maritime` | ✓ | ✓ `parc-routier` | — | GeoJSON/CSV/WFS | none published |
| NB `nb511` | ✓ | ✓ events | ✓ events | — | — | — | ✓ | ✓ | — | — | JSON/XML | 10 / 60 s |
| NL `nl511` | ✓ | ✓ events | ✓ events | — | — | — | ✓ | ✓ | — | — | JSON/XML | 10 / 60 s |
| YT `yt511` | ✓ | ✓ events | ✓ events | ✓ | ✓ | — | — | ✓ | ✓ | — | JSON/XML | 10 / 60 s |
| NS | ✓ (site) | ✓ (site) | ✓ (site) | ✓ open data, static | inventory only | ✓ open data, static | ✓ (site) | ✓ (site) | — | link only | XML/JSON; Socrata JSON/CSV | unknown |
| PEI | — | ✓ (site) | ✓ (site) | — | — | ? | ✓ (site) | ✓ (site) | — | — | XML/JSON | unknown |
| NWT | ✓ (map) | ✓ (map) | ? | ? | — | ✓ (site, unread) | historical only | ✓ (map) | — | historical scale data | XLSX/HTML | — |
| NU | — | — | — | — | — | — | — | — | — | — | — | — |

Notes on the table:

- **"events"** means the 511 platform's event endpoint, which the adapter reads. Its `EventType`
  covers roadwork, closures, and accidents/incidents.
- **Ontario seasonal loads.** Ontario lists "Seasonal Loads" as its own endpoint, which matters for
  spring thaw.
- **Ontario restrictions.** The event `Restrictions` field carries width, height and weight. The
  adapter types such an event as `restriction` and keeps it advisory.
- **Yukon** publishes weight and bridge restrictions as their own endpoints. Its rights answer is
  the most valuable of the blocked five.

## Survey: the four not yet registered, and Québec reconfirmed

### Nova Scotia

- **Service:** 511 Nova Scotia, https://511.novascotia.ca/. Its menu lists traffic events, cameras,
  road conditions, ferries, the Halifax Harbour bridges, plows, the five-year construction plan, and
  commercial vehicle safety.
- **API:** `GET /api/v2/get/event?format=json` answers `400 application/xml <Error><Message>Invalid
  Key</Message></Error>`, the same as the 511 platform elsewhere. However, a made-up path answers
  the same way, because the key is checked first. The probe therefore proves a key gate, not which
  endpoints exist.
- **Docs:** `/developers/doc` is **404**, and `/developers/resources` is empty. Rate limit unknown.
- **Site terms:** https://511.novascotia.ca/about/about says *"Terms of Use — Non-Commercial or
  Educational Reproduction … readily available for personal and public non-commercial (educational)
  use"*. That is a stronger refusal than Alberta's silence.
- **Open data:** data.novascotia.ca (Socrata) is under the Nova Scotia Open Government Licence. It
  permits commercial use ("including for commercial purposes"), with the attribution *"Contains
  information licensed under the Open Government Licence – Nova Scotia"*. Relevant static layers:
  - Road Weight Designations (`y7tt-edu2`)
  - Spring Weight Restrictions exempt / non-exempt roads (`qusm-8w98`, `8xvj-phvi`). These are lists
    of roads, not whether a restriction is in force today.
  - Structures (`gs26-c3fm`): inventory only, with no limits.
  - Ferry schedules (`7izn-s679`): last updated 2023.
- **Status:**
  - 511 feed: rights review. Its own terms say non-commercial, so a request has to ask for an
    exception, not a confirmation.
  - Open-data weight layers: candidate, rights look clear, adapter not built. They are static rule
    data, which belongs to the verified-restriction path, not the advisory feed path.

### Prince Edward Island

- **Service:** Prince Edward Island 511, https://511.gov.pe.ca/. It lists traffic events, cameras,
  parks and ferries, with no road-conditions item.
- **API:** same platform. `400 Invalid Key`, `/developers/doc` **404**, resources empty. Rate limit
  unknown.
- **Site terms:** https://511.gov.pe.ca/about/disclaimer is a warranty disclaimer only, with no reuse
  licence.
- **Open data:** data.princeedwardisland.ca (ArcGIS Hub) has no operational road data. The PEI Open
  Government Licence page could not be read (403), so its terms are unverified.
- **Status:** 511 feed rights review. Nothing operational in open data.

### Northwest Territories

- **Service:** the highway-conditions link now redirects to https://drivenwt.ca/, a map-only app
  showing conditions for all-season and winter roads, closures, cameras and weather stations. It is
  not the 511 platform: `/developers/*` and `/api/v2/get/event` are **404**.
- **Terms:** https://www.gov.nt.ca/terms says *"Material may not be used or reproduced for commercial
  purposes without the prior written consent arranged by the Department's Communications Unit."*
- **Open data:** opendata.gov.nt.ca (CKAN) is under OGL – NWT, which permits commercial use. The
  official English attribution wording was not found; the French is *"Contient des renseignements
  visés par la licence du gouvernement ouvert des Territoires du Nord-Ouest"*. The data is historical
  or static only: weigh-scale records, ferry tracking, ferry and ice-road opening dates to 2021/22,
  traffic volumes.
- **Status:** no published live feed. Live data would need written consent from the Department.
  Historical open data is low operational value.

### Nunavut

- **Status:** not applicable. There is no inter-community highway network; the Kivalliq and Grays
  Bay roads are at study or assessment stage. No territorial 511 or road feed was found.
- **Unverified:** gov.nu.ca answered with a challenge page and the open data portal was unreachable
  from here.

### Québec, reconfirmed

- **Channel:** MTMD publishes its road data as open data on Données Québec (organization `mtq`, 31
  datasets). The machine-readable channel is the WFS at
  `https://ws.mapserver.transports.gouv.qc.ca/swtq`, with no key.
- **Québec 511 itself** (quebec511.info) blocked automated requests, and no public developer API for
  it was found. *Unverified.*
- **CC BY 4.0 datasets, all commercially reusable with credit:**
  - `travaux-routiers`: read today
  - `condition-routiere-hivernale-du-reseau-routier-mtq`
  - `avertissement-routier`: road and bridge closures
  - `camera-de-circulation`
  - `zone-de-degel`: spring thaw
  - `reseau-camionnage`: trucking network
  - `liaison-maritime`: ferries
  - `parc-routier`: rest areas
  - `structure`
  - `refuge-de-la-route-blanche`
- **`limite-de-charge`** (load limits on structures) is **CC BY-ND 4.0** and offered "for
  consultation only" via WMS. A derived product cannot be built from it, so it needs its own rights
  review.
- **Next adapter: `avertissement-routier`.** It is the closures dataset, so it is the most valuable
  addition. It is not built in this checkpoint.

## Open rights questions

- **Ontario 511 logo.** Ontario's Developer Resources page calls the 511 logo "mandatory in
  conjunction with Ontario 511", and OGL – Ontario excludes "names, crests, logos, or other official
  symbols" from its grant. No logo is used. The textual attribution is shown. The question is tracked
  in `docs/P6_DATA_PERMISSION_REQUESTS.md` §7.
- **AB, MB, NB, YT, NL and SK** are individually tracked in §6 of the same document.
- **NS 511** needs an exception request, since its terms say non-commercial. **NWT live data** needs
  written consent. Neither request is drafted yet.
