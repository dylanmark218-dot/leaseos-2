# Data Source Registry Verification — Geospatial & Road Data for a Commercial Alberta/BC Trucking–Oilfield Logistics Product

**Retrieval date for all sources: September 9, 2026.** This is for a COMMERCIAL product, so commercial-use terms are material throughout. Two uses matter most and are flagged where relevant: (a) commercial fleet use, and (b) offline redistribution of bundled data to field tablets.

## TL;DR
- **Nine of the eleven data sources are cleanly usable commercially and redistributable** under open licences (OGL–Canada, OGL–Alberta, OGL–British Columbia, ODbL). The only copyleft is OpenStreetMap's ODbL, whose share-alike attaches to a *Derivative Database* — this is the single biggest legal watch-item for an offline bundle, though the rendered on-tablet map is a *Produced Work* (attribution only).
- **The two AER products (ST37, ST102) and Alberta 511 are NOT under a standard open licence** — they are governed by AER Terms of Use and 511 developer terms respectively; commercial use and offline redistribution are unverified and must be confirmed in writing before shipping. Alberta 511 requires a key and throttles to **10 calls per 60 seconds** (verified on the official developer page) and exposes a **Bridge Restrictions** endpoint directly relevant to heavy/over-dimensional oilfield loads.
- **All seven software components are safe for a commercial closed-source product**: MapLibre (BSD), Valhalla (MIT, truck costing accepts height/width/length/weight/axle_load/hazmat), Martin (Apache-2.0/MIT), Pelias (MIT), GDAL (MIT/X), Turf.js (MIT). PostGIS is GPL-2.0-or-later but its own FAQ confirms ordinary database use does not force you to release application source. [PostGIS](https://postgis.net/documentation/faq/gpl-license/)

## Key Findings
- **OSM/ODbL is the one copyleft trap.** Bundling an OSM extract (a PBF or database) into your offline package is *conveying a Derivative Database*, which must remain ODbL and be offered to recipients on request. The rendered map on the tablet is a *Produced Work* needing only attribution. If you substantially combine OSM with AER/ATS data into one routing graph, that combined database is likely itself a Derivative Database. **Internal-only fleet use is not "public use" and triggers no share-alike obligation.**
- **AER is actively retiring ST37/ST102 shapefiles in favour of File Geodatabase.** Verbatim (AER ST37 page): *"As part of this update, the spatial data format is transitioned from shapefiles to a geodatabase. The current shapefile format will be maintained during a three-month transition period, after which it will be retired."* [Alberta Energy Regulator](https://www.aer.ca/data-and-performance-reports/statistical-reports/st37) [aer](https://www.aer.ca/data-and-performance-reports/statistical-reports/st37) Adopt FGDB ingestion now.
- **Alberta 511 exposes a Bridge Restrictions endpoint** (`/help/endpoint/bridgerestrictionpoi`) alongside Road Conditions, Events, Alerts, Cameras, Weather Stations, and Inspection Stations — highly relevant to your use case.
- **CWFIS explicitly disclaims being the authoritative local fire source** and states it is "not designed for operational fire management purposes." [canada](https://natural-resources.canada.ca/forests-forestry/wildland-fires/current-wildland-fire-activity-cwfis) It must be displayed as advisory only.
- **DriveBC and NRN/CanVec/ATS are unambiguously open** (OGL-BC / OGL-Canada / OGL-Alberta) with commercial use and redistribution expressly permitted.

## Details — Per-Source Registry Blocks

### 1. OpenStreetMap
- **sourceKey:** osm
- **displayName:** OpenStreetMap
- **authority:** OpenStreetMap Foundation
- **sourceUrl:** https://www.openstreetmap.org / https://planet.openstreetmap.org (regional extracts via Geofabrik)
- **licenceName:** Open Database License (ODbL) v1.0
- **licenceUrl:** https://opendatacommons.org/licenses/odbl/1-0/
- **attributionRequired:** yes
- **attributionText:** Base requirement is attribution to "OpenStreetMap" linked to openstreetmap.org/copyright; the historical form **"© OpenStreetMap contributors"** is expressly accepted. Attribution is only required when a Produced Work is used *publicly*. [OpenStreetMap Foundation](https://osmfoundation.org/wiki/Licence/Attribution_Guidelines) For a rendered map, the guideline suggests "Map data from OpenStreetMap."
- **shareAlikeObligation:** **YES — attaches to a Derivative Database.** Produced Works (rendered tiles/images) do NOT trigger share-alike, only attribution (ODbL §4.3). [openstreetmap](https://lists.openstreetmap.org/pipermail/legal-talk/2012-October/007267.html) A Derivative Database (an OSM extract, or OSM substantially combined with other data) must be offered under ODbL to recipients when publicly used/conveyed (ODbL §4.4/§4.6). [OpenStreetMap Foundation](https://osmfoundation.org/wiki/Licence/Licence_and_Legal_FAQ)
- **commercialUsePermitted:** yes (OSM Legal FAQ: "You can charge any amount of money you want for any service or data you provide.") [OpenStreetMap](https://wiki.openstreetmap.org/wiki/Legal_FAQ)
- **redistributionPermitted:** yes — but bundling the OSM extract/database offline to tablets = conveying a Derivative Database, so ODbL (share-alike + offer of data) attaches. Rendered tiles bundled offline are a Produced Work (attribution only).
- **requiresApiKey:** no (for planet/extract downloads; do not use the public tile server or main API for bulk)
- **rateLimitCalls / window:** N/A for bulk extracts
- **updateIntervalHours:** continuous; Geofabrik extracts daily
- **formats:** PBF, OSM XML, Shapefile/GeoPackage (via extract providers), GeoJSON
- **CRS:** EPSG:4326 (WGS84)
- **notes:** FLAG — copyleft is the key risk. Keep the OSM-derived database logically separable from proprietary data to avoid share-alike attaching to the whole database; rely on the Produced Work path for the visible map.

### 2. National Road Network (NRN) — Canada
- **sourceKey:** nrn
- **displayName:** National Road Network (NRN) — AB
- **authority:** Natural Resources Canada / Statistics Canada (distributed via open.canada.ca; the AB record is also mirrored via GeoDiscover Alberta / open.alberta.ca)
- **sourceUrl:** https://open.canada.ca/data/en/dataset/3d282116-e556-400c-9306-ca1a3cada77f (AB record: cb4911f1-89d8-47f0-92e1-2cbfac3d300b)
- **licenceName:** The AB record on open.alberta.ca lists **Open Government Licence – Alberta**; the national NRN dataset is under **Open Government Licence – Canada**. (Older GeoBase references cite a legacy "GeoBase Unrestricted Use" agreement; the current portal records use OGL.)
- **licenceUrl:** https://open.alberta.ca/licence (OGL-AB) / https://open.canada.ca/en/open-government-licence-canada (OGL-Canada)
- **attributionRequired:** yes
- **attributionText:** "Contains information licensed under the Open Government Licence – Canada" [Open Government](https://open.canada.ca/en/open-government-licence-canada) (or "– Alberta", matching the record used)
- **shareAlikeObligation:** none
- **commercialUsePermitted:** yes (OGL grants a worldwide, royalty-free, perpetual, non-exclusive licence including for commercial purposes)
- **redistributionPermitted:** yes — offline bundling permitted; no copyleft
- **requiresApiKey:** no
- **rateLimitCalls / window:** none published (bulk FTP + WMS/ESRI REST services)
- **updateIntervalHours:** Verbatim from NRN metadata: "The frequency of maintenance aimed is of at least one update a year" [ScienceBase](https://www.sciencebase.gov/catalog/item/4fe9e8e2e4b04b50557536cd) (~8,760h)
- **formats:** GML, KML, Shapefile (plus WMS and bilingual ESRI REST services)
- **CRS:** geographic coordinates, NAD83 (CSRS)
- **notes:** Two linear entities (Road Segment, Ferry Connection Segment) and three point entities (Junction, Blocked Passage, Toll Point), with attributes including Functional Road Class, Number of Lanes, Structure Type, Route Number/Name, Exit Number. [Gouvernement ouvert](https://ouvert.canada.ca/data/dataset/cb4911f1-89d8-47f0-92e1-2cbfac3d300b) [Arctic SDI catalogue](https://catalogue.arctic-sdi.org/geonetwork/srv/api/records/3d282116-e556-400c-9306-ca1a3cada77f) Verbatim: "The spatial resolution of the data is approximately 1:10,000 (but only a general estimate since the data was originated from multiple sources)"; provides "over 1 million kilometres of up-to-date centerline road network data." [Canadian GIS](https://canadiangis.com/national-road-network-nrn-canadian-open-data.php) Conforms largely to ISO 14825. [Gouvernement ouvert](https://ouvert.canada.ca/data/dataset/cb4911f1-89d8-47f0-92e1-2cbfac3d300b) [Arctic SDI catalogue](https://catalogue.arctic-sdi.org/geonetwork/srv/api/records/3d282116-e556-400c-9306-ca1a3cada77f)

### 3. CanVec
- **sourceKey:** canvec
- **displayName:** CanVec
- **authority:** Natural Resources Canada
- **sourceUrl:** CanVec series records on https://open.canada.ca; FTP via https://ftp.maps.canada.ca and geogratis.gc.ca
- **licenceName:** Open Government Licence – Canada (some library/legacy pages cite the "GeoGratis License Agreement for Unrestricted Use of Digital Data"; [Carleton University](https://library.carleton.ca/find/gis/geospatial-data/natural-resources-canada-topographic-maps-canvec) NRCan states CanVec's distribution licence is ODbL-compatible)
- **licenceUrl:** https://open.canada.ca/en/open-government-licence-canada
- **attributionRequired:** yes
- **attributionText:** "Contains information licensed under the Open Government Licence – Canada"
- **shareAlikeObligation:** none
- **commercialUsePermitted:** yes
- **redistributionPermitted:** yes — offline bundling permitted
- **requiresApiKey:** no
- **rateLimitCalls / window:** none published
- **updateIntervalHours:** "Data updates are offered approximately every two months" [Natural Resources Canada](https://natural-resources.canada.ca/sites/nrcan/files/earthsciences/pdf/CanVec_en.pdf) (~1,440h)
- **formats:** GML, Shapefile, File Geodatabase (FGDB), GeoPackage; [OpenStreetMap](https://wiki.openstreetmap.org/wiki/CanVec) also KMZ and WMS
- **CRS:** NOT FOUND on the publisher page (verify per download; NRCan vector data is generally geographic NAD83)
- **notes:** 60+ topographic feature classes in 8 themes including Transport Features (roads, trails, bridges, railways — derived from the NRN and National Railway Network) [canada](https://search.open.canada.ca/data/?page=3) and Manmade/Resource Management features (energy/oil-gas sites). NRCan warns some content derived from the legacy NTDB is "not up to date." [McMaster University Libraries](https://library.mcmaster.ca/maps/geospatial/canvec-series)

### 4. Alberta Township System (ATS)
- **sourceKey:** ats
- **displayName:** Alberta Township System v4.1 Polygons (Township Index)
- **authority:** Government of Alberta — Provincial Geospatial Centre / GeoDiscover Alberta
- **sourceUrl:** https://geospatial.alberta.ca/titan/rest/services/base/alberta_township_system/MapServer ; open-data record https://open.alberta.ca/opendata/45dbaf52-c4c8-4e5d-89fe-d14cec62fc41
- **licenceName:** Open Government Licence – Alberta
- **licenceUrl:** https://open.alberta.ca/licence
- **attributionRequired:** yes
- **attributionText:** "Contains information licensed under the Open Government Licence – Alberta" [Aboutcode](https://scancode-licensedb.aboutcode.org/can-ogl-alberta-2.1.html)
- **shareAlikeObligation:** none
- **commercialUsePermitted:** yes (OGL-Alberta: "worldwide, royalty-free, perpetual, non-exclusive licence to use the Information, including for commercial purposes") [SPDX](https://spdx.org/licenses/OGL-Canada-2.0.html) [Aboutcode](https://scancode-licensedb.aboutcode.org/can-ogl-alberta-2.1.html)
- **redistributionPermitted:** yes — offline bundling permitted
- **requiresApiKey:** no
- **rateLimitCalls / window:** none published (ArcGIS REST MapServer)
- **updateIntervalHours:** NOT FOUND (v4.1 base grid; infrequently changed — derived from ATS Version 4.1 dated March 31, 2005) [Alberta](https://geodiscover.alberta.ca/geoportal/rest/metadata/item/a2f3c476882041a8b7e0def645122a1a/xml)
- **formats:** ESRI REST/MapServer; Shapefile via GeoDiscover Alberta / AltaLIS; HTML/XML metadata
- **CRS:** NAD83 10TM AEP (also available geographic)
- **notes:** The service metadata states verbatim: "Use of the information will be governed by the terms of the Open Government Licence – Alberta, in force as of the date the user accesses the information." [Alberta](https://geospatial.alberta.ca/titan/rest/services/base/alberta_township_system/MapServer) Provides Township Index and Section polygons (meridian/range/township/section). Note that meridian/range/township/section/quarter-section/LSD attributes derive from this ATS family.

### 5. Alberta Township System with Road Allowances
- **sourceKey:** ats_road_allowance
- **displayName:** ATS Section with Road Allowance (source layer BF_ATS_SEC_RA_POLYGON_V41)
- **authority:** Government of Alberta — Provincial Geospatial Centre
- **sourceUrl:** https://geospatial.alberta.ca/titan/rest/services/base/alberta_township_system/MapServer (Section-with-Road-Allowance outline/label layers)
- **licenceName:** Open Government Licence – Alberta
- **licenceUrl:** https://open.alberta.ca/licence
- **attributionRequired:** yes
- **attributionText:** "Contains information licensed under the Open Government Licence – Alberta"
- **shareAlikeObligation:** none
- **commercialUsePermitted:** yes
- **redistributionPermitted:** yes — offline bundling permitted
- **requiresApiKey:** no
- **rateLimitCalls / window:** none published
- **updateIntervalHours:** NOT FOUND
- **formats:** ESRI REST/MapServer; Shapefile via GeoDiscover Alberta / AltaLIS
- **CRS:** NAD83 10TM AEP
- **notes:** CONFIRMED as a distinct layer within the same ATS service — the Township Index layer contains "No road allowance segments," [Alberta](https://geodiscover.alberta.ca/geoportal/rest/metadata/item/a2f3c476882041a8b7e0def645122a1a/xml) while the "Section with Road Allowance" layer (BF_ATS_SEC_RA_POLYGON_V41) is published separately in the same MapServer. [Alberta](https://geospatial.alberta.ca/titan/rest/services/base/alberta_township_system/MapServer) FLAG: the exact LSD-with-road-allowance polygon layer name should be confirmed at the service or via AltaLIS/GeoDiscover at download time.

### 6. AER ST37 — List of Wells in Alberta
- **sourceKey:** aer_st37
- **displayName:** ST37: List of Wells in Alberta
- **authority:** Alberta Energy Regulator (AER)
- **sourceUrl:** https://www.aer.ca/data-and-performance-reports/statistical-reports/st37 (catalogue: https://www1.aer.ca/ProductCatalogue/10.html)
- **licenceName:** AER Terms of Use / "Copyright and Disclaimer" (NOT a standard open licence)
- **licenceUrl:** https://www.aer.ca/copyright-and-disclaimer
- **attributionRequired:** verify per AER Terms of Use
- **attributionText:** NOT FOUND (governed by AER Terms of Use, not an OGL). AER's spatial-data page states the content "is governed by the terms and conditions set out below ('Terms of Use')." [Aer](https://portal.aer.ca/providing-information/data-and-reports/maps-mapviewers-and-shapefiles.html)
- **shareAlikeObligation:** none
- **commercialUsePermitted:** **unknown — FLAG.** Not a standard open licence; requires legal review of AER Terms of Use.
- **redistributionPermitted:** **unknown — FLAG.** Confirm with AER before bundling offline into a commercial product.
- **requiresApiKey:** no (direct ZIP download; some data also via OneStop)
- **rateLimitCalls / window:** none published
- **updateIntervalHours:** updated monthly [Alberta Energy Regulator](https://www.aer.ca/data-and-performance-reports/activity-and-data/spatial-data) (~720h)
- **formats:** File Geodatabase (ST_37_GeoDB.zip, ~1.23 GB), Excel (ST_37_Excel.zip, ~170 MB), Shapefile (ST37_Shapefiles.zip, ~532 MB). **Shapefile is being retired** — verbatim: "the spatial data format is transitioned from shapefiles to a geodatabase. The current shapefile format will be maintained during a three-month transition period, after which it will be retired." [Alberta Energy Regulator](https://www.aer.ca/data-and-performance-reports/statistical-reports/st37) [aer](https://www.aer.ca/data-and-performance-reports/statistical-reports/st37)
- **CRS:** NOT FOUND on page (verify in bundled metadata; AER data is typically NAD83)
- **notes:** Reflects the life cycle of Alberta wells — surface holes, bottom holes, production strings, and geometry information. [Alberta Energy Regulator](https://www.aer.ca/data-and-performance-reports/statistical-reports/st37) [aer](https://www.aer.ca/data-and-performance-reports/statistical-reports/st37) FLAG both commercial-use and redistribution as requiring written confirmation under AER Terms of Use.

### 7. AER ST102 — Facility List
- **sourceKey:** aer_st102
- **displayName:** ST102: Facility List
- **authority:** Alberta Energy Regulator (AER) / Petrinex
- **sourceUrl:** https://www1.aer.ca/productcatalogue/35.html ; spatial-data hub https://www.aer.ca/data-and-performance-reports/activity-and-data/spatial-data
- **licenceName:** AER Terms of Use / "Copyright and Disclaimer"
- **licenceUrl:** https://www.aer.ca/copyright-and-disclaimer
- **attributionRequired:** verify per AER Terms of Use
- **attributionText:** NOT FOUND
- **shareAlikeObligation:** none
- **commercialUsePermitted:** **unknown — FLAG for legal review**
- **redistributionPermitted:** **unknown — FLAG**
- **requiresApiKey:** no
- **rateLimitCalls / window:** none published
- **updateIntervalHours:** updated monthly (~720h)
- **formats:** Shapefile (Facility List Shapefile, ST102); geodatabase for related AER spatial products
- **CRS:** NOT FOUND
- **notes:** ST102 is a complete list of Alberta facilities with a Petrinex Facility ID that have reported volumetric activity. [Aer](https://www1.aer.ca/productcatalogue/35.html) Facility types: battery, compressor station, custom treating facility, gas plant, gas gathering system, injection/disposal facility, meter station, oil sands processing plant, waste plant, water source, and others. [Aer](https://www1.aer.ca/productcatalogue/35.html) Part A = new/active facilities; Part B = suspended/retired/abandoned; the shapefile includes both but only facilities with a geographic location. [Aer](https://www1.aer.ca/productcatalogue/35.html)

### 8. Alberta 511
- **sourceKey:** ab511
- **displayName:** 511 Alberta Developer API
- **authority:** Government of Alberta — Alberta Transportation and Economic Corridors
- **sourceUrl:** https://511.alberta.ca/developers/doc
- **licenceName:** NOT FOUND (developer terms via account registration; no explicit open licence stated on the developer doc page)
- **licenceUrl:** NOT FOUND
- **attributionRequired:** verify at registration
- **attributionText:** NOT FOUND
- **shareAlikeObligation:** none
- **commercialUsePermitted:** **unknown — FLAG.** Governed by developer terms; requires an account/key.
- **redistributionPermitted:** **unknown — FLAG.** For offline field devices, the correct and intended pattern is to cache server-side and serve from your own backend rather than redistribute the raw API.
- **requiresApiKey:** yes — a registered Alberta.ca account is required, then request a developer API key; most calls require the query-string `key` parameter. [alberta](https://511.alberta.ca/developers/doc)
- **rateLimitCalls:** 10
- **rateLimitWindowSeconds:** 60 — VERIFIED verbatim on the official developer page: "Throttling is enabled. Ten calls every 60 seconds." [alberta](https://511.alberta.ca/developers/doc)
- **updateIntervalHours:** real-time / near-real-time (road conditions, events, alerts refreshed continuously)
- **formats:** REST / JSON
- **CRS:** EPSG:4326 (lat/long in responses)
- **notes:** Endpoints confirmed on the official page: Road Conditions (`/winterroads`), Cameras, Rest Areas and Turnouts, Ferries, Parks, Events, Alerts, Weather Stations, Inspection Stations, Rest Stops and Turnouts, and **Bridge Restrictions** (`/help/endpoint/bridgerestrictionpoi`). [alberta](https://511.alberta.ca/developers/doc) Given the 10 calls/60s throttle, poll into your own cache and distribute snapshots from your backend; the API is explicitly not intended as an application backend. [Steve Trefethen](https://www.stevetrefethen.com/511-org-api-rate-limit/)

### 9. DriveBC Open511
- **sourceKey:** drivebc_open511
- **displayName:** Open511-DriveBC API
- **authority:** Government of British Columbia — Ministry of Transportation and Infrastructure
- **sourceUrl:** https://api.open511.gov.bc.ca/ ; help/guidelines: https://api.open511.gov.bc.ca/help
- **licenceName:** Data under **Open Government Licence – British Columbia** (OGL-BC); the API itself under the DriveBC API Terms of Use [Gouvernement ouvert](https://ouvert.canada.ca/data/dataset/23a839e3-8fb4-4569-bb3d-c28a7621f687)
- **licenceUrl:** https://www2.gov.bc.ca/gov/content/data/policy-standards/data-policies/open-data/open-government-licence-bc
- **attributionRequired:** yes
- **attributionText:** "Contains information licensed under the Open Government Licence – British Columbia"
- **shareAlikeObligation:** none
- **commercialUsePermitted:** yes (OGL-BC grants use including for commercial purposes)
- **redistributionPermitted:** yes for the data under OGL-BC with attribution; API access governed by the Terms of Use. Offline bundling of cached event data is permitted under OGL-BC.
- **requiresApiKey:** no (public API; joining the distribution list via DriveBC@gov.bc.ca is recommended to be notified of changes) [Gov](https://api.open511.gov.bc.ca/help)
- **rateLimitCalls / window:** NOT FOUND (no explicit numeric rate limit published; API Terms of Use apply)
- **updateIntervalHours:** real-time (only the Events resource is dynamic; the other four resources return largely static content) [Gov](https://api.open511.gov.bc.ca/help)
- **formats:** XML, JSON (Open511 specification) [Gov](https://api.open511.gov.bc.ca/help)
- **CRS:** EPSG:4326 (WGS84, per Open511/GeoJSON)
- **notes:** Event types include road closures, planned work/construction, incidents, and extreme weather conditions. [Open Government Portal](https://open.canada.ca/data/en/dataset/23a839e3-8fb4-4569-bb3d-c28a7621f687) English-only in the current implementation. [Gov](https://api.open511.gov.bc.ca/help) Verbatim: "Use of the Information provided by this API is governed by the Open Government Licence – British Columbia ('OGL-BC')." [Gov](https://api.open511.gov.bc.ca/help)

### 10. MSC GeoMet
- **sourceKey:** msc_geomet
- **displayName:** MSC GeoMet (GeoMet-OGC-API / GeoMet-Weather)
- **authority:** Environment and Climate Change Canada — Meteorological Service of Canada
- **sourceUrl:** https://api.weather.gc.ca/ ; WMS https://geo.weather.gc.ca/geomet ; docs https://eccc-msc.github.io/open-data/msc-geomet/readme_en/
- **licenceName:** Environment and Climate Change Canada Data Server End-use Licence [Weather](https://api.weather.gc.ca/)
- **licenceUrl:** https://eccc-msc.github.io/open-data/licence/readme_en/ (terms of service: https://www.canada.ca/en/transparency/terms.html)
- **attributionRequired:** yes (per End-use Licence — credit Environment and Climate Change Canada)
- **attributionText:** verify exact wording in the End-use Licence
- **shareAlikeObligation:** none
- **commercialUsePermitted:** yes ("Access to the MSC GeoMet services is anonymous and free of charge"; [github](https://eccc-msc.github.io/open-data/msc-geomet/readme_en/) [Eccc-msc](https://eccc-msc.github.io/open-data/readme_en/) End-use Licence permits reuse with attribution)
- **redistributionPermitted:** yes with attribution; building a local archive should use MSC Datamart, not GeoMet [github](https://eccc-msc.github.io/open-data/usage-policy/readme_en/) [Canada.ca](https://www.canada.ca/en/environment-climate-change/services/climate-change/canadian-centre-climate-services/display-download/advanced-tools.html)
- **requiresApiKey:** no (anonymous, free)
- **rateLimitCalls:** soft limit — verbatim from the MSC Open Data Service Usage Policy: "If you or your application's usage involves 86,400 requests per day or higher (about 1 request per second), contact us"; "Any consistent usage over this limit may be subject to having access limited or otherwise revoked." [github](https://eccc-msc.github.io/open-data/usage-policy/readme_en/)
- **rateLimitWindowSeconds:** 86400 (per-day guidance; ~1 request/second)
- **updateIntervalHours:** varies by product (near-real-time for alerts/radar; model cycles for NWP)
- **formats:** WMS, WMTS, OGC API–Features (GeoJSON, CSV), OGC API–Coverages, WCS [Canada.ca](https://www.canada.ca/en/environment-climate-change/services/climate-change/canadian-centre-climate-services/display-download/advanced-tools.html)
- **CRS:** multiple (EPSG:4326, EPSG:3857 and others via OGC services)
- **notes:** Weather alerts are classified as **warnings, watches, advisories and statements**. [Weather](https://geo.weather.gc.ca/geomet?lang=E&request=GetCapabilities&service=WMS) Caching guidance (verbatim): "Ensure there is no usage of 'no-cache' headers in HTTP requests"; "Bulk and batch retrieval of WMS tiles is prohibited"; [github](https://eccc-msc.github.io/open-data/usage-policy/readme_en/) add a meaningful HTTP User-Agent header.

### 11. CWFIS — Canadian Wildland Fire Information System
- **sourceKey:** cwfis
- **displayName:** Canadian Wildland Fire Information System
- **authority:** Natural Resources Canada — Canadian Forest Service
- **sourceUrl:** https://cwfis.cfs.nrcan.gc.ca/ ; datamart https://cwfis.cfs.nrcan.gc.ca/datamart ; OGC services https://cwfis.cfs.nrcan.gc.ca/geoserver/ows
- **licenceName:** Open Government Licence – Canada (confirm on the specific datamart product record)
- **licenceUrl:** https://open.canada.ca/en/open-government-licence-canada
- **attributionRequired:** yes
- **attributionText:** "Contains information licensed under the Open Government Licence – Canada"
- **shareAlikeObligation:** none
- **commercialUsePermitted:** yes (subject to confirming OGL-Canada on the specific product)
- **redistributionPermitted:** yes
- **requiresApiKey:** no (WMS/WFS/WCS via GeoServer + direct downloads)
- **rateLimitCalls / window:** none published
- **updateIntervalHours:** daily during fire season (fire weather, fire behaviour, hotspot maps, generally May–September); fire weather year-round [FERGI](https://www.frames.gov/catalog/899) (~24h)
- **formats:** WMS/WFS/WCS (GeoServer), [Cif-ifc](https://www.cif-ifc.org/wp-content/uploads/2026/01/CIF-E-Lecture-pres-CWFIF-CWFIS-Website-and-WIPS-March-2026.pdf) plus downloadable products (shapefile, CSV, raster)
- **CRS:** multiple via GeoServer OGC services
- **notes:** **FLAG / CRITICAL CAVEAT** — publisher states verbatim: "The information, maps and data services available through the Canadian Wildland Fire Information System are approximations based on available data, and may not show the most current fire situation. Additional information and maps on current conditions, are available on the website of the fire management agency for your region of interest (Province, Territory or National Park)." [Canadian Wildland Fire Information System](https://cwfis.cfs.nrcan.gc.ca/datamart/metadata/fwi) NRCan also states: "While not designed for operational fire management purposes, the CWFIS provides national wildland fire monitoring and reporting information." Must be displayed as advisory only, with a pointer to the provincial/territorial fire agency.

## Software Component Licences

| Component | Licence (SPDX) | Version | Caveats |
|---|---|---|---|
| **MapLibre GL JS** | BSD-3-Clause | 6.x latest (5.x recent major) | Permissive; embed in closed-source SaaS/mobile WebView; only requirement is retaining the copyright notice. |
| **MapLibre Native** | BSD-2-Clause | Android SDK 11.11.0 | Permissive; based in part on FreeType. |
| **Valhalla** | MIT | 3.8.3 (released July 25, 2026) [GitHub](https://github.com/valhalla/valhalla/releases) | Truck costing documented parameters: `height`, `width`, `length`, `weight` (shared vehicle options with truck defaults: 4.11 m / 2.6 m [GitHub](https://github.com/valhalla/valhalla/pull/3648) / 21.64 m / 21.77 t), and truck-only `axle_load` (default 9.07 t), `hazmat` (default false), plus `axle_count` (default 5). **All six queried parameters are supported.** |
| **Martin tile server** | Apache-2.0 OR MIT (dual, "at your option") | martin-v1.14.0 | Permissive; serves vector tiles from PostGIS/PMTiles/MBTiles. |
| **Pelias** | MIT | current | Permissive; operational dependencies include Elasticsearch and libpostal. [GitHub](https://github.com/pelias/interpolation) |
| **GDAL/OGR** | MIT/X | 3.13.x current | Core is MIT; a GDAL *binary* can be built against GPL/LGPL/proprietary dependencies, so a specific build may carry stricter terms — verify your build's dependency licences. |
| **Turf.js** | MIT | 7.4.0 (7.x) | Permissive. |
| **PostGIS** | GPL-2.0-or-later | 3.6.4 stable | Per the PostGIS FAQ (verbatim): the GPL "share and share alike" clauses "do not apply to the ordinary uses people make of a spatial database, such as loading data into it and running queries against it… The only exception would be if you made changes to the PostGIS source code, and distributed your changed version of PostGIS." [PostGIS](https://postgis.net/documentation/faq/gpl-license/) Running PostGIS as an unmodified database service does NOT force disclosure of your application source. |

## Recommendations
1. **Stage 1 — Immediate legal action on the three non-open sources (AER ST37, AER ST102, Alberta 511).** These are the only blockers. Obtain written confirmation from AER (Terms of Use) and from Alberta 511 (developer terms) that (a) commercial use and (b) offline redistribution/caching to field tablets are permitted. **Do not ship these three in the offline bundle until confirmed.** Benchmark that changes the plan: a signed licensing agreement or explicit written permission clears them for inclusion.
2. **Stage 1 — Architect the OSM boundary now.** Keep the OSM-derived routing database logically separable from proprietary/AER/ATS layers. Treat the visible on-tablet map as a Produced Work (attribution only). If you ever *publicly convey* the combined database, be prepared to offer the OSM-derived Derivative Database under ODbL. Benchmark: if the database is used internally only (fleet devices, no third-party access to the database itself), share-alike is not triggered and no ODbL offer is required — but confirm your distribution model qualifies as internal.
3. **Stage 2 — Build a server-side caching layer for the live APIs.** For Alberta 511 (10 calls/60s) and DriveBC (no published limit), poll into your own backend and push periodic snapshots to tablets; never proxy the raw API to devices. For GeoMet, keep aggregate usage well below ~1 request/second, honour cache headers (no `no-cache`), avoid bulk WMS-tile scraping, and set a descriptive User-Agent.
4. **Stage 2 — Migrate AER ingestion to File Geodatabase immediately**, since the shapefile format is being retired after the three-month transition.
5. **Stage 3 — Ship a single consolidated attribution/credits screen** in the app: "© OpenStreetMap contributors"; "Contains information licensed under the Open Government Licence – Canada / Alberta / British Columbia"; an ECCC credit for GeoMet; and an AER credit per its terms.
6. **Stage 3 — Treat CWFIS as advisory-only.** Display a disclaimer and a link to the relevant provincial fire agency; never use it as an operational or safety-critical fire input.

## Caveats
- **AER ST37/ST102 and Alberta 511:** commercial-use and offline-redistribution terms are AMBIGUOUS/unverified against a standard open licence — explicitly flagged for confirmation. These are the two specific uses that matter for this product.
- **CRS fields marked NOT FOUND** (CanVec, AER ST37/ST102) should be confirmed from each dataset's bundled metadata at download; NRCan/AER Alberta data is typically NAD83 but verify per product.
- **ATS LSD-with-road-allowance exact layer name** should be confirmed at the ArcGIS REST service or via AltaLIS/GeoDiscover Alberta.
- **Version pinning:** MapLibre GL JS, Turf.js, Martin, Valhalla and PostGIS release versions move frequently — pin exact versions at build time.
- **PostGIS 3.6.4:** confirmed as the current stable series on postgis.net's release notes, but the exact 3.6.4 release date could not be independently verified (the most recent explicitly dated point release documented was 3.6.2, Feb 6, 2026; [PostGIS](https://postgis.net/2025/09/PostGIS-3.6.0/) a Windows-installer page also lagged at 3.6.2). Verify the precise 3.6.4 date on the PostGIS release-notes page before pinning.
- **NRN AB record licence:** the Alberta mirror lists OGL–Alberta while the national NRN is OGL–Canada; both permit commercial use and redistribution, but cite the licence matching whichever record/endpoint you actually ingest.
- All findings reflect publisher pages as retrieved **September 9, 2026**; live API terms and dataset licences can change — re-verify before each major release.