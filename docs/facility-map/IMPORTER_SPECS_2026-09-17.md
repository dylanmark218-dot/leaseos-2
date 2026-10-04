# Regulator facility layers — importer specifications (retrieved 2026-09-17)

What the importers in `server/facilityDirectoryRouter.ts` (`facilityDirectory.arcgis.*`) were built against. Verified from the official endpoints on the retrieval date; the "not verified" items are named so nobody assumes them.

## Saskatchewan — Petroleum facilities (importable now)

| | |
|---|---|
| Layer | `https://gis.saskatchewan.ca/egis/rest/services/Economy/Petroleum/FeatureServer/17` ("Facilities") — all feature classes from the PETROLEUM schema in the Production Data Warehouse |
| Geometry | **polygon** footprints, WKID 2151 (latestWkid **2957**, NAD83(CSRS) / UTM 13N, metres). No lat/long fields — the importer takes the outer-ring centroid and reprojects (`server/_core/projections.ts`) |
| Fields (verified) | OBJECTID, SITEID, LICENCENUM, LICDATE, LICTYPE, LICSTATUS, OWNERBAID, OWNERNAME, SURFACELOC, FIELDOFFIC, INFRAID, INFRSTATUS, CONSDATE, DECOMDATE, ISRETRO, GEOMETRYSO, DATAEXTRAC (+ Shape__Area, Shape__Length); display field OWNERNAME; MaxRecordCount 2000 (paginate with `resultOffset`) |
| Preset mapping | id/licenceNumber → LICENCENUM · operator → OWNERNAME · facilityType → LICTYPE · status → LICSTATUS · legalLocation → SURFACELOC (`SK_FACILITIES` in `server/_core/arcgisImport.ts`) |
| Licence | **Government of Saskatchewan Standard Unrestricted Use Data Licence v2.0** — named in the item metadata: "This product contains information licensed under the Government of Saskatchewan Standard Unrestricted Use Data License (Version 2.0)." Grant: "worldwide, royalty-free, perpetual, non-exclusive licence to use the Information, including for commercial purposes"; attribution: "Contains information licensed under the Government of Saskatchewan Standard Unrestricted Use Data Licence (Version 2.0)."; as-is, no warranty. Register row `sk_unrestricted_use_v2` → **confirmed, cache permitted** (0143) |
| Not verified | the LICTYPE / LICSTATUS coded-value domains (run `returnDistinctValues=true` at import time; suspended-facility reports show a "WASTE FACILITY" sub-type with WP-prefixed codes) |
| Also | Ministry of Environment "Mining and Industrial Facilities" layer (`services3.arcgis.com/zcv98lgAl8xQ04cW/.../EBP Facilities/FeatureServer/0`, industrial waste management facilities; "locations are approximate"); the New and Active Facilities report (PDF, Registry Downloads) and the bi-weekly Facility Licence Inventory (XLSX) |

## British Columbia — BC Energy Regulator (importable once a person maps the fields)

| | |
|---|---|
| Facility Locations (Permitted) | `https://geoweb-ags.bc-er.ca/arcgis/rest/services/PASR/PASR_FACILITY_PT/MapServer/0` — points, WKID 102190 (latestWkid **3005**, NAD83 / BC Albers). Definition: facilities used to "gather, process, measure, store or dispose of" petroleum, gas, water or a substance; points collected on/after 2016-07-11 |
| Sump Locations | `https://geoweb-ags.bc-er.ca/arcgis/rest/services/OPERATIONAL/SUMP_LOCATIONS_PT/MapServer/0` — drilling-waste sumps (only `SUMP_CLOSURE_DATE` confirmed as a field) |
| Facility type codes | "Facility Codes" table, item `d1113cf8a515441e9e6b8e722d80a472` — decode the type column with it |
| Licence | **BC Energy Regulator Open Data Licence** (`https://www.bc-er.ca/files/gis/BCER-Open-Data-Licence.pdf`, based on OGL–BC v2.0): "including for commercial purposes"; attribution "Contains information licenced under the BC Energy Regulator Open Data Licence". Register row `ogl_bcer` corrected (0143) |
| Not verified | **both layers' field schemas** — `facilityDirectory.arcgis.inspect` reads them from `?f=pjson`; a person supplies the mapping; `checkMapping` refuses any field the layer does not have. No dedicated "disposal stations" service was found (disposal is a facility type within the facility layer) |

## How the layers are fetched (checked 2026-09-24)

The importers fetch through the egress guard (`server/_core/egressGuard.ts`, Node edge `egressHttp.ts`): https only, public addresses only (checked after DNS and again at every redirect, and the connection pinned to the checked addresses), no cookies or credentials, 30 s and 16 MiB per request. A layer URL outside those rules is refused as the caller's error, before any request; `importFeatures` fetches nothing but refuses to record such a URL as a regulator source.

**Which layers may be fetched at all (0233, 2026-10-03).** Before the egress guard, every layer URL — `inspect`, `importFromLayer` and the URL `importFeatures` records — must be an enabled endpoint of a source a person approved in the approved external source registry for `facility_directory.arcgis_import` (`docs/architecture/EXTERNAL_SOURCE_REGISTRY.md`). The three layers above are seeded as endpoints of `sk_petroleum_gis` and `bcer_gis`, each matching its own layer and that layer's `/query`, and those two sources are seeded as *requests* for approval: until a manager approves them, the importer refuses with `BLOCKED — source registry: … is pending approval`. The licence gate (`facilitySourceLicences`, confirmed and cache-permitted) is unchanged and still applies after the registry. Each run now writes a provenance row (`externalDatasetImports`: source, endpoint, revision, approval, layer edit date, SHA-256 of the bytes read) that `facilityImportRuns.externalDatasetImportId` points at. The three layers answered again on 2026-10-03 (19, 15 and 10 fields).

https-only loses no source. The three importable layers above answered over https through the guard on 2026-09-24: Saskatchewan Petroleum facilities `?f=pjson` 200 (19 fields) and a 2000-feature query page (1.49 MB); both BCER layers `?f=pjson` 200 (15 and 10 fields). Saskatchewan's `http://` URL answers 301 to the same https URL. No layer in this document, the seed data or the licence migrations is named with `http://`. `?f=pjson` is served as `text/plain`, `/query?f=json` as `application/json`, so both are accepted.

## Alberta — hydrovac facilities list (parseable PDF, OGL–Alberta)

Fixed five-column table: **Authorization | Company Name | Location | Contact Information | Acceptable Material**, grouped under NORTH REGION / SOUTH REGION. Authorization is either numeric (EPEA) or `WM …` (AER-regulated). Location mixes addresses and DLS in parentheses (`Fort Kent (9-14-063-04-W4M)`). "Acceptable Material" recurs as a small vocabulary (non-hazardous waste; non-hazardous hydrovac waste; non-contaminated hydrovac slurry; a hazardous waste management facility; non-oilfield hazardous hydrovac must have a recoverable hydrocarbon component; no restrictions; clean / contaminated hydrovac slurry; drilling mud). Header note: "Information in this document is based on information provided by the facility." Licence: OGL–Alberta ("Contains information licensed under the Open Government Licence – Alberta"). Example rows: `00432185 | Alberta Village Environmental Services Ltd | Building E 6415-75 Street Edmonton | 780-446-8444 | Non-hazardous Waste`; `WM 212 | Pure Environmental Waste Management | Fort Kent (9-14-063-04-W4M) | 587-792-0855 | A hazardous waste management facility`. The PDF parser is not built yet (P3.8 remaining).

## Alberta Energy Regulator — ST102 / ST107 (machine-readable, but not redistributable)

ST102 (Facility List): PDF/TXT monthly and a **shapefile** (only facilities with a geographic location); types include *injection/disposal facility*, *waste plant*, *water source*; attributes Facility ID, Facility Name, Operator, Sub Type, Location, Licence Number, Operational Status. ST107: XLS/Tableau, attributes Company, Facility Name, Location, Application number, Approval, Amendments. Terms: "Reproduction of multiple copies of materials on this site, in whole or in part, for the purposes of commercial redistribution is prohibited except with prior written permission of the AER." → register row `aer_copyright` stays `permission_required`; the importer refuses it (P6.8).
