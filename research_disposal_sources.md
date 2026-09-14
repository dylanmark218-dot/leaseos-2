# Disposal directory source notes

The directory must not claim to be a complete list of every disposal site in Canada and the United States. Disposal acceptance and operating status vary by jurisdiction and facility, and must be verified before dispatch.

| Source | Use in LeaseOS | Notes |
|---|---|---|
| Government of Canada Open Data: Hazardous Waste Public Information | Canadian generator, carrier, and receiver spatial seed data | The dataset is province/jurisdiction dependent and links to year-specific resources. |
| Ontario Hazardous Waste Public Information | Ontario receiver/generator/carrier spatial data and waste-class context | Includes historical/year-specific resources, with 2022 listed as the latest annual ZIP in the extracted page and a 2002–2022 registration/classes CSV. |
| U.S. EPA RCRAInfo / Envirofacts | U.S. hazardous-waste handler identity, location, permit/closure, compliance, and cleanup context | EPA describes RCRAInfo as a national inventory/program-management system fed by state environmental agencies. |
| FMCSA National Hazardous Materials Route Registry | U.S. state-level hazardous-material route restrictions and map/PDF/Excel references | Route restrictions are state-specific; the directory should store source links, state, HM class scope, and verification date. |

## Product boundary

A public registry record does not by itself prove that a facility accepts a particular hydrovac slurry, liquid waste, solid waste, tanker, dangerous-goods class, volume, or truck configuration. LeaseOS should show acceptance as **verified**, **needs facility confirmation**, or **not established**, and require human review before dispatch.

Canada should preserve provincial identifiers and, where applicable, Western Canadian LSD/grid context. U.S. facilities should use street address, coordinates, state/county, EPA/state identifiers, and any township/range context where available; LSD is not a universal U.S. identifier.

Route results must be treated as a planning aid until validated against current commercial-vehicle restrictions, bridge/clearance postings, seasonal closures, HazMat route restrictions, facility instructions, and local road conditions.

## References

1. [Government of Canada Open Data — Hazardous Waste Public Information](https://open.canada.ca/data/en/dataset/1a12f1f0-d36f-4aee-8b79-135934dea63d)
2. [Ontario Data Catalogue — Hazardous Waste Public Information](https://data.ontario.ca/dataset/hazardous-waste-public-information)
3. [U.S. EPA — RCRAInfo Overview](https://www.epa.gov/enviro/rcrainfo-overview)
4. [FMCSA — National Hazardous Materials Route Registry by State](https://www.fmcsa.dot.gov/regulations/hazardous-materials/national-hazardous-materials-route-registry-state)
