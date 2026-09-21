# Authoritative public registries of oilfield waste / disposal / treatment facilities in Western Canada — provenance and licence findings (retrieved 2026-09-17)

Research run on 2026-09-17 to decide what an evidence row in the facility directory may honestly claim, and under what licence. Every row of `facilitySourceLicences` (0139) traces to a line here. Verify the operative clauses yourself before relying on them commercially; the quotes were read from the cited pages on the retrieval date.

## The three findings that shape the build

1. **AER ST107 (AER Approved Oilfield Waste Management Facilities)** is the authority for "verified" in Alberta — WM approval number, approval holder, facility name, surface location as a legal land description — but AER material is copyright-protected: "Reproduction of multiple copies of materials on this site, in whole or in part, for the purposes of commercial redistribution is prohibited except with prior written permission of the AER." Not an Open Government Licence. **Store the WM approval number as the verification key and link out; never cache the list** (register row `aer_copyright`, status `permission_required`; human item P6.8).
2. **Alberta EPEA lists on open.alberta.ca / alberta.ca** — the hydrovac-accepting facilities list (dated 2026-04-10) and the hazardous waste / hazardous recyclables facility contacts list — are under the **Open Government Licence – Alberta**: "worldwide, royalty-free, perpetual, non-exclusive licence to use the Information, including for commercial purposes"; attribution "Contains information licensed under the Open Government Licence – Alberta". **Cacheable with attribution** (`ogl_alberta`). Locations are town + address or LSD, not lat/long.
3. **BC Energy Regulator** facility index, disposal stations and sump locations (Data Centre, GIS open-data portal) are under the OGL – BC Energy Regulator; BC Data Catalogue records under **OGL – British Columbia v2.0** ("including for commercial purposes"; attribution "Contains information licensed under the Open Government Licence – British Columbia"; applies only to records that specify it). The catalogue's "Hazardous waste facilities" dataset is **DEPRECATED** — do not use (`ogl_bcer`, `ogl_bc`).

**Saskatchewan** publishes no standalone downloadable directory; facilities are licensed through IRIS (Directives S-01, PNG001, PNG008); geospatial data under the Standard Unrestricted Use Data Licence v2.0. **Manitoba** Petroleum Branch GIS map gallery — no open licence identified. Both: verification by reference only until confirmed (`sk_unrestricted_use_v2` unconfirmed, `mb_unconfirmed` permission required; P6.9). **Federal** ECCC publishes no facility registry; authorized-facility status is provincial (XBR SOR/2021-25; CNMTS is account-based); canada.ca content under OGL – Canada (`ogl_canada`).

## Sources by jurisdiction

| Jurisdiction | Source | URL | Lists | Format / cadence | Coordinates | Licence |
|---|---|---|---|---|---|---|
| AB | AER ST107 | https://www.aer.ca/providing-information/data-and-reports/statistical-reports/st107 | first/third-party OWMFs by WM approval number | Tableau viewer; ongoing (page 2026-06-04, aligned to the new Directive 058) | legal land description only | AER copyright — no commercial redistribution without written permission |
| AB | AER Directive 058 / 047 / Manual 034 | https://www.aer.ca/documents/directives/Directive058.pdf ; …/Directive047.pdf | oilfield waste codes (general / other / special), reporting codes | PDF; new edition released 2026-03-05, **effective 2026-06-04**, 90-day transition; Petrinex accepts the new codes from May 2026 production data | — | AER copyright (readable) |
| AB | AER Active Disposal Well List; ST102 Facility List; ST37 | https://www.aer.ca/data-and-performance-reports/activity-and-data/lists-and-activities/active-disposal-well-list | disposal wells (monthly); facilities with Petrinex IDs incl. injection/disposal and custom treating | monthly / periodic; ST102 & ST37 ship shapefiles / geodatabase | ST102/ST37 spatial products carry coordinates | AER copyright |
| AB | EPEA hazardous facilities contacts | https://www.alberta.ca/hazardous-facilities (PDFs on open.alberta.ca) | EPEA-approved hazardous waste / recyclables facilities (approval numbers) | PDF; periodic (an edition published June 2020) | town + LSD | **OGL – Alberta** |
| AB | Facilities that accept hydrovac waste | https://www.alberta.ca/system/files/epa-facilities-list-hydrovac-waste.pdf | facilities accepting hydrovac slurry, with conditions | PDF dated 2026-04-10 | town + address / LSD | **OGL – Alberta** |
| AB | Landfills / waste facilities (Class I / II / III) | https://www.alberta.ca/landfills ; Waste Control Regulation, Alta Reg 192/1996 | landfill classes and approvals (DRAS) | web / regulation | — | OGL – Alberta (alberta.ca); regulation via King's Printer |
| BC | BC Energy Regulator Data Centre / GIS portal | https://www.bc-er.ca/data-reports/data-centre/ ; https://data-bc-er.opendata.arcgis.com/ | facility index, disposal stations, drilling-waste sumps | CSV / GIS; gas plant list every 24 h | GIS layers carry coordinates | **OGL – BC Energy Regulator** |
| BC | Ministry of Environment and Parks — Hazardous Waste Regulation | https://www2.gov.bc.ca/gov/content/environment/waste-management/hazardous-waste | registered facilities and licensed carriers | web search tools | authorization records | OGL – BC where specified |
| BC | BC Data Catalogue "Hazardous waste facilities" | https://catalogue.data.gov.bc.ca/dataset/hazardous-waste-facilities | **DEPRECATED** | — | unverified | do not use |
| SK | Ministry of Energy and Resources — IRIS; Directives S-01, PNG001, PNG008 | https://www.saskatchewan.ca/ (publications.saskatchewan.ca) | facility licences incl. waste processing and disposal wells | account-based; PDFs | DLS in licence records | Standard Unrestricted Use Data Licence v2.0 (geospatial) — unconfirmed for a facility list |
| MB | Petroleum Branch GIS Map Gallery | https://www.gov.mb.ca/iem/petroleum/gis/index.html | wells, batteries (incl. facilities that store, process or dispose of oilfield waste) | interactive GIS, updated December 2025 | GIS | **no open licence identified** — permission required |
| CA | ECCC — XBR SOR/2021-25; CNMTS | https://www.canada.ca/en/environment-climate-change/services/managing-reducing-waste/cross-border-regulations/cnmts-user-guide.html | no public facility registry; authorized facilities are provincial | account-based | — | OGL – Canada for guidance |

## Waste-stream vocabularies to map to

| Vocabulary | Publisher | Where | Notes |
|---|---|---|---|
| Oilfield waste codes (general / other / special) | AER | Directive 058; Manual 034 | e.g. produced water = "WATER: Water – Produced (including brine solutions)" — quoted from the research, **not yet verified against the directive text** (P6.11) |
| Reporting codes | AER | Directive 047 App. 2/3 | NONOFD, REC, DISP etc. |
| Dangerous Oilfield Waste criteria | AER / Alberta | Directive 058; WCR Schedule 1 | hazardous / dangerous classification |
| Landfill classes I / II / III | Alberta | Waste Control Regulation | routing of inert / non-hazardous / hazardous solids |
| Hazardous waste categories | BC | Hazardous Waste Regulation, BC Reg 63/88 | BC routing |
| Disposal / recycling operation codes | ECCC | XBR Schedule 1 | cross-border / interprovincial |

## Caveats

- Swan Hills Treatment Centre (EPEA approval 1744) was reported in February 2024 as slated to close in early 2026 — re-verify before any "verified/active" status (P6.10).
- Most Alberta lists are LSD-only; coordinate precision must be derived and flagged.
- The exact current licence and schema of the deprecated BC dataset could not be verified.
- The AER's new Directive 047/058 codes take effect 2026-06-04; the vocabulary table must be re-mapped to the new edition.
