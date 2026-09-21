# LeaseOS Disposal Facility Map — Design Specification

**Date:** 2026-09-17  
**Baseline:** `leaseos-fieldroute-v6.zip`  
**Target checkpoint:** LeaseOS FieldRoute v7

## Purpose

Create one source-backed Western Canadian facility directory and map for industrial waste, oilfield fluids, septic receiving, landfills, transfer stations, and related service contractors. The directory is a planning and records tool. It must never imply that a facility accepts a load or that a route is legal without current supporting evidence.

## Safety invariants

1. A map pin is not disposal authorization.
2. A company service area is not represented as a facility entrance.
3. Unknown, approximate, expired, or conflicting evidence fails closed.
4. A load can be dispatched only when its classification, facility acceptance, account/approval requirements, and route review are satisfied by current evidence.
5. Industrial fluids, hydrovac slurry, domestic septage, hazardous solids, and ordinary commercial waste remain distinct waste streams.
6. Historical brands remain searchable but point to the current operator only when an acquisition or rebrand has a source.
7. Coordinates are WGS84 decimal degrees and always carry precision and provenance metadata.

## Scope

### Included

- Every identifiable operator, facility, receiving station, landfill, transfer station, and named service location supplied in the approved source brief.
- Operator and ownership history for SECURE/Tervita, Waste Connections/R360, GFL/Terrapure, Clean Harbors/Safety-Kleen, and other named operators.
- Map, list, search, filters, coordinate display/copying, selected-facility detail, and route-planning handoff.
- Waste-stream compatibility evaluation with explicit reasons and blocking conditions.
- Links from a facility to loads, trips, stops, manifests, scale/disposal tickets, billing reconciliation, and offline route packages.
- CSV and GeoJSON exports with the same safety metadata as the database records.
- Audit report identifying verified, approximate, ambiguous, and rejected claims.

### Excluded from this checkpoint

- Claiming province-wide completeness.
- Automated permit interpretation or legal-route authorization.
- Live booking, payment, card-lock access, or direct operator integrations.
- Inferring road suitability from satellite imagery.
- Treating a contractor's office or service region as a disposal point.

## Data model

### `facilityOperators`

Stores the current legal/operating entity, aliases, former names, parent organization, public contact channels, and evidence.

### `facilities`

The existing table remains the canonical facility record and gains stable identity and operational fields:

- `facilityKey`, `operatorId`, `name`, `aliases`
- `facilityType`, `status`, `statusAsOf`
- `address`, `municipality`, `province`, `postalCode`, `country`
- `latitude`, `longitude`, `coordinatePrecision`, `coordinateAccuracyMetres`
- `coordinateSourceUrl`, `coordinateVerifiedAt`
- `operatingHours`, `phone`, `emergencyPhone`, `gateInstructions`
- `dispatchPhone`, `email`, `websiteUrl`, `accountRegistrationUrl`
- `googleMapsPlaceUrl`, plus separately sourced site and entrance coordinates
- `accountRequired`, `preApprovalRequired`, `scaleAvailable`
- `requiredDocuments`, `restrictions`, `notes`
- `recordConfidence`, `lastVerifiedAt`

Coordinate precision is one of `verified_entrance`, `verified_site`, `approximate_site`, `community_only`, or `unknown`. Rows without a usable coordinate remain searchable but are not rendered as routable pins.

### `facilityCapabilities`

One row per documented waste stream or service, rather than a comma-separated acceptance claim:

- `facilityId`, `wasteCode`, `handlingMethod`
- `acceptanceStatus`: `verified`, `confirmation_required`, `not_accepted`, `unknown`
- physical limits and special conditions
- evidence source, observed/effective/expiry dates, verifier, and notes

Initial controlled waste categories include domestic septage, portable-toilet waste, grease-trap waste, hydrovac slurry, drilling mud/cuttings, produced water, flowback, oily water/emulsion, contaminated soil, hazardous solids, asbestos, C&D, commercial MSW, tires, scrap metal, and clean wood.

### `facilityEvidence`

Preserves field-level provenance without overwriting conflicting claims:

- source publisher, title, URL, source type, retrieved date
- claim type and claim value
- effective/expiry dates
- confidence and review state
- reviewer and review timestamp

Operator pages, regulators, municipalities, and facility confirmation are preferred. Search-result snippets and third-party directories can create leads only.

### `facilityAliases` and `operatorRelationships`

Preserve former brands and acquisitions without duplicating the physical facility.

### `loadFacilityAssessments`

Immutable decision receipts connect a load classification to a facility at a point in time. A receipt stores the input snapshot, matched capability evidence, outcome, reason codes, evidence age, coordinate precision, and engine version.

## Compatibility engine

The pure engine returns one of:

- `compatible_verified`
- `facility_confirmation_required`
- `incompatible`
- `insufficient_information`

Only `compatible_verified` can satisfy the disposal-eligibility gate. Even that outcome does not bypass route, account, hours, volume, or facility-specific confirmation rules.

Required inputs are load/waste classification, physical state, hazard/DG information when applicable, quantity, selected facility, and current evidence. Missing classification or stale/contradictory evidence returns `insufficient_information`.

## API boundaries

The facility router will support:

- filtered list and single-record detail
- map-feature retrieval with bounded viewport
- create/update through validated administrative procedures
- evidence review and capability confirmation
- load-to-facility assessment
- CSV and GeoJSON export

Mutations require authenticated tenant scope and write an audit event. Public seed data never becomes tenant-verified evidence merely because it was imported.

## Map and directory interface

The existing disposal directory becomes a split map/list workspace:

- clustered pins colored by facility type
- a separate visual treatment for approximate or community-only pins
- filters for province, operator, facility type, waste stream, operating status, verification state, coordinate precision, and account/pre-approval requirements
- detail drawer with coordinates, precision, evidence age, acceptance status, restrictions, documents, and contacts
- one-tap call/email and links to the official facility website, permit/registry record, and public account or card-lock registration when available
- copy address/coordinates, Google Maps place and directions handoffs, optional Apple Maps handoff, and LeaseOS route-planning actions
- Android Google Maps intent with standards-based browser fallback; handoffs use the verified entrance coordinate when available and the labelled site coordinate otherwise
- a warning that consumer navigation can propose roads unsuitable or unlawful for the current commercial vehicle
- visible warning that map presence does not prove acceptance

The field map can consume the same feature contract. No duplicate pin dataset is maintained.

## Seed-data policy

Every location from the source brief is resolved into one of four outcomes:

1. verified physical facility;
2. approximate physical facility needing confirmation;
3. operator/service location that is not a disposal facility;
4. ambiguous or unsupported claim retained in the audit report but excluded from routable pins.

Municipality centroids may be included only as `community_only`, with a label that they are discovery aids. They cannot be selected as a trip destination.

## Offline behavior

Assigned trips cache selected facility identity, coordinate, precision, capability decision, evidence timestamp, gate instructions, required documents, and emergency contact. If cached evidence expires or conflicts with a newer server record, the app displays the conflict and blocks a fresh disposal authorization until reconciled.

## Testing

Tests are written before production changes. Coverage includes:

- coordinate range and precision rules;
- approximate coordinates cannot authorize dispatch;
- septic cannot match generic TRD/SWD capability;
- hydrovac slurry cannot match a municipal septage-only station;
- unknown or stale acceptance fails closed;
- explicit rejection overrides weaker positive evidence;
- alias resolution does not duplicate sites;
- CSV/GeoJSON preserve precision and verification fields;
- API authentication and tenant isolation;
- map filtering and route handoff;
- contact actions, official-site links, and encoded Google Maps/Apple Maps direction URLs;
- migrations and existing FieldRoute regression suite.

## Deliverables

- database migration and schema changes;
- compatibility and validation engines;
- authenticated API procedures;
- updated interactive disposal directory/map;
- source-backed seed dataset;
- CSV and GeoJSON exports;
- facility verification/audit report;
- checkpoint manifest with hashes and test evidence;
- versioned v7 ZIP.

## Acceptance criteria

- All supplied named locations are accounted for in the seed dataset or audit report.
- Every routable pin has valid WGS84 coordinates, precision, source, and verification state.
- Every displayed phone, email, website, account link, and map-place link is source-labelled; missing contact values remain unknown rather than guessed.
- Google Maps is only an external navigation handoff after LeaseOS route review and never satisfies the commercial-route gate.
- No approximate/community pin can produce an authorized result.
- Waste compatibility is reason-coded and reproducible from an immutable receipt.
- Existing tests, new tests, typecheck, and production build pass from the packaged checkpoint.
- The ZIP contains no dependencies, secrets, build caches, or unrelated duplicate source files.
