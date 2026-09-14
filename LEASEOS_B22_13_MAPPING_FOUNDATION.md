# LeaseOS — v22.13 Checkpoint: The Mapping Foundation, From Open Data

| | v22.12 | **v22.13** |
|---|---|---|
| Tables | 254 | **257** (`atsLegalSubdivisions`, `accessRoadSegments`, `geoImportRuns`) |
| Migrations | 68 | **69** (`0070`) |
| Role-authorized procedures | 378 | **383** (+5, `geo`) |
| Sensitive (fail-closed) permissions | 96 | **98** |
| Bare `protectedProcedure` | 0 | **0** |
| Tests | 1,504 | **1,510** (+6, `geoImport.test.ts`) |
| Test files | 85 | **86** |
| Parity | 254/254 | **257/257 column-level** |
| CI gate | PASS | **PASS** |
| **Live import** | — | **810 ATS parcels, 269 road segments, TWP 54 RGE 18 W5** |

Every count is read from the source. Reserved slots untouched.

---

## The sources, verified on the live web

Each link was fetched and read before a line was written:

| Source | What it serves | Licence | Verified |
|---|---|---|---|
| **Alberta Township System** MapServer, layer 20 | ATS v4.1 **Legal Subdivision with Road Allowance** polygons — PID, meridian, range, township, section, quarter, LSD, road allowance, descriptor | Open Government Licence — Alberta (stated in the service description) | JSON / geoJSON / PBF; 1,000 features per page |
| **access_facility_roads** MapServer, layer 0 | **Base Features Access Road** — "the authoritative source of road data for the province of Alberta"; NAME, HWY_NUMBER, ROAD_CLASS, FEATURE_TYPE, GEO_SOURCE, GEO_DATE | Alberta Environment and Parks, Government of Alberta | geoJSON; 2,000 per page; legend read from the service's own renderer |
| **Geofabrik** Canada / Alberta extracts | OSM `alberta-latest.osm.pbf` (333 MB), Canada (6.0 GB, 2026‑09‑10) | **ODbL 1.0** — commercial use permitted, share-alike and attribution obligations | Confirmed, not yet imported |
| **AER ST37** | List of Wells in Alberta — geodatabase 1.23 GB, shapefile 532 MB, Excel | **Commercial redistribution prohibited without written permission** | Confirmed — **and that is why no ST37 importer ships here** |

The AER licence is the finding worth stating plainly: ST37 is free to
download and free for non-commercial use, but "reproduction of multiple
copies … for the purposes of commercial redistribution is prohibited except
with prior written permission." LeaseOS is a commercial product. The
registry already records `aer_st37` as **permission-blocked**, and the
importer's gate refuses any source not cleared for commercial use, so an
ST37 importer cannot be written into this tranche by accident. Written
permission from AER Integrated Communications is a person's task, and it
stays on the blocker list.

## What was built

**Two fabrics, imported and attributed.** `atsLegalSubdivisions` holds the
polygon ring, a centroid computed from it, the bounding box and the grid
fields; `accessRoadSegments` holds the path, Alberta's FEATURE_TYPE with its
published label, a surface kind derived from that legend, the geometry
source and date the province states. Both carry source key, layer, import
run and retrieval time. `geoImportRuns` records every import: endpoint,
query, features fetched, rows written and skipped, whether the page was
truncated, who ran it.

**A gate on provenance.** An import is refused unless the source is in the
registry, recorded `commercialUsePermitted = yes`, and `verified`. Tested
both ways.

**The locator.** Parse the LSD, find the parcel, compute the centroid from
the polygon — then find where a truck reaches it: the nearest truck-suitable
road within range, preferring one that touches the parcel. A driveway,
ferry, ford or ramp is never offered as a lease access. **The centroid is
the land; the access point is the road**, and the response carries both with
the reason. Not imported is a named outcome; no access point is a named
outcome.

**`ats_v41` at last.** v22.0 defined that coordinate source and could not
produce it. A lease location's coordinates are now verified from the
imported grid by a second person — the parcel centroid, or the access point
on request — recorded `ats_v41`, confidence high, verified.

## The live run

Against the real services, a whole township:

```
ATS sections 1-36 (six pages): fetched 810, wrote 810
township extent: 53.62819,-116.65490 → 53.71561,-116.50772
access roads: fetched 269, wrote 269
attribution: Contains information licensed under the Open Government Licence – Alberta
13-24-054-18-W5 → centroid 53.684625, -116.529010
                | access 53.681790, -116.527907 (One Lane Gravel Road, 323 m)
```

## Corrected on the way

The reserved-word audit caught `range` and `section` before they shipped —
renamed `rangeNumber` and `sectionNumber`, which is exactly what that guard
exists for. `roleProcedure` takes procedure names, not permission names; my
first draft passed permissions and the gate refused to start. And a real
finding: **`seedExternalDataSources` existed but nothing in the application
had ever called it** — only a test did — so the licence registry the
importers stand on was empty in a fresh database. The importers now ensure
it, additively.

## Not built, and named

OSM/Geofabrik import and the routing graph (P0 remains: no routing source is
loaded, and `spatial.routeRequest` still answers UNKNOWN). AER ST37 wells —
permission-blocked, above. NRN and CanVec cross-checks. Tiles and an offline
map. Multi-part road geometry is taken as its longest part, and the run
counts what it dropped. The locator searches a bounding box, not an index —
fine for a township, to be revisited at provincial scale.

## Blockers

**P0/P5** — no routing source; the fabrics now exist for one to be built on.
**AER ST37 / ST102** — written permission for commercial use, now with the
exact licence text and contact recorded. **Alberta 511** — API key.
**P9** — no verified rule.
