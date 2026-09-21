# Project TODO

- [x] Establish elegant LeaseOS / FieldRoute design system and responsive dashboard shell
- [x] Build operations dashboard with active work, route status, alerts, and field-performance summaries
- [x] Build field map workspace with Google Maps lease/job locations, route context, markers, layer controls, and offline-ready status
- [x] Build job workflow with assignment, status progression, task details, and mode-specific procedures
- [x] Build evidence capture and review interface with traceable timestamps and storage-backed attachments
- [x] Build safety and compliance workspace with checklists, incident signals, and chronological timeline
- [x] Add database schema and typed procedures for jobs, evidence metadata, safety/compliance records, and map/route context
- [x] Add Vitest coverage for core backend procedures and validation helpers
- [x] Validate responsive behavior, interaction states, and production build

# Follow-up verification

- [x] Fix Google Maps loading reliability and add visible loading/error/fallback states
- [x] Implement a cached operational snapshot for the offline-ready map view
- [x] Implement true mode-specific job procedures for hydrovac, recovery, transport, and general work
- [x] Wire evidence review verification to the backend and reflect uploaded records in the UI
- [x] Add persisted route/map context schema and typed procedures
- [x] Expand Vitest coverage to safety procedures, evidence verification, upload validation, and map context
- [x] Re-run responsive and interaction validation after the fixes

# Final data-flow fixes

- [x] Persist an actual offline route/marker snapshot payload instead of only a readiness flag
- [x] Invalidate the evidence list after successful upload so new records appear immediately

# New operator and compliance expansion

- [x] Add operator identity workspace with secure profile, document wallet, OCR review state, expiry warnings, training, certifications, insurance, and emergency contact fields
- [x] Add unit identity workspace with VIN/plate, equipment configuration, QR/NFC-ready identifier, inspection status, maintenance status, and unit documents
- [x] Add multi-unit job assignment with unit role, arrival/departure, hours, mileage, work performed, and billing context
- [x] Add biometric-assisted signature flow using device-authenticated confirmation semantics without storing raw biometric data
- [x] Add authorized job completion package and delivery audit trail
- [x] Add structured load profile flow with SDS/regulatory source references, verified classification status, and explicit no-invention safety boundary
- [x] Add placard assistant and physical unit label manager with verification-required states
- [x] Add disposal facility intelligence, hours/restrictions, contact actions, and ETA closure warnings
- [x] Add disposal arrival / scale-ticket OCR workflow with traceable attachment metadata
- [x] Add interactive pre-trip training, actual pre-trip, post-trip defect capture, and maintenance follow-up workflows
- [x] Add typed persistence and procedures for operators, units, job units, compliance documents, load profiles, facilities, inspections, maintenance defects, deliveries, and audit records
- [x] Add Vitest coverage and responsive validation for the new workspaces

# Gap closure pass

- [x] Surface certifications and insurance in the operator wallet and add an OCR-assisted review state
- [x] Surface VIN, equipment configuration, and unit document wallet in unit identity
- [x] Implement visible multi-unit assignment fields for arrival/departure, hours, mileage, work performed, and billing
- [x] Add a device-authenticated signing handoff with an explicit platform-safe confirmation boundary
- [x] Add delivery audit-trail list with recipient-level statuses
- [x] Add SDS/source review, verified DG classification display, and scale-ticket arrival workflow
- [x] Complete actual pre-trip checklist, defect capture, and maintenance follow-up UI flows

# Final gap closure requirements

- [x] Implement real OCR review interaction with extracted fields and approve/reject actions for operator documents
- [x] Build a unit document wallet backed by complianceDocuments filtered to unit ownership
- [x] Wire the multi-unit crew table to persisted jobUnits and provide an assignment form
- [x] Make device-auth handoff explicit with a platform-safe confirmation step before signature mutation
- [x] Add SDS/source review controls, verified DG presentation, and disposal scale-ticket arrival metadata flow
- [x] Build an actual pre-trip checklist and maintenance follow-up/work-order form

# Final wiring verification

- [x] Render OCR extracted fields with persisted approve/reject review state
- [x] Render a real unit document list filtered by unit owner
- [x] Replace the hardcoded crew table with persisted jobUnits and a real assignment form
- [x] Add SDS/source review controls, verified classification state, and scale-ticket metadata capture
- [x] Add a structured maintenance follow-up/work-order form linked to maintenance defects

# Location identity and physical passport expansion

- [x] Add first-class lease/well records with surface LSD, downhole LSD, UWI/API equivalent, well licence, operator, field, province, access road, gate, hazards, emergency context, coordinates, source, and last-verified metadata
- [x] Add map layers and location identity card for separate surface and downhole well locations
- [x] Add role-aware digital unit passport for QR/NFC identifiers without embedding sensitive documents in the code
- [x] Add unit passport detail with identity, documentation, condition, maintenance, trip, load, disposal, inspection, and signature history
- [x] Add manifest chain linking generator, surface/downhole LSD, well, material, UN status, vehicle, trailer, driver, route, facility, scale tickets, photos, and signatures
- [x] Add QR/NFC scan entry flow with role-specific visibility for inspection, driver, mechanic, dispatcher, and administrator contexts
- [x] Add chronological unit and location history with GPS/time/evidence associations
- [x] Add scan-driven workflow handoff from well identification to truck identity, driver confirmation, manifest, route, disposal, signature, and billing context
- [x] Add typed persistence and procedures for locations, well identities, unit passport metadata, manifests, chain links, and scan audit events
- [x] Add Vitest coverage and responsive validation for the location identity and passport workflows

# Location passport integration pass

- [x] Add surface/downhole markers to the real Google Maps workspace
- [x] Make passport access role change visible fields and persist randomized QR/NFC identifiers
- [x] Add persisted unit passport history and manifest chain metadata rendering
- [x] Add scan-driven step progression and mobile/tablet validation coverage

# Compliance document and chain-of-custody expansion

- [x] Add universal tracking identifiers by artifact type for tailgate, field ticket, BOL, DG document, waste manifest, disposal ticket, DVIR, work order, maintenance, permit, photo package, invoice, and trip
- [x] Add formal tailgate/JSA record with hazards, PPE, controls, participants, units, voice-review state, photos, and signatures
- [x] Add linked document relationship graph across job, driver, units, location, load, DG document, manifest, route, disposal, signatures, billing, and maintenance
- [x] Add disposal package transfer with recipient, channel, attachments, delivery status, retry status, message ID, and acknowledgement workflow
- [x] Add facility acceptance readiness checks and paper-document-required safeguards for unauthorized electronic TDG workflows
- [x] Add structured TDG shipping-document fields with source references, regulatory profile, version/effective date, ERAP, and human verification boundary
- [x] Add regulatory document checklist and job compliance score for operator, vehicle, load, route, site, disposal, and completion
- [x] Add trip evidence package and supporting-document association for ELD/GPS, dispatch, BOL, manifest, tickets, fuel, tolls, DVIR, maintenance, signatures, and disposal
- [x] Add retention lifecycle, legal hold, jurisdiction-specific retention metadata, and regulatory versioning fields
- [x] Add QR/email/secure transfer/archive actions plus recipient acknowledgement records
- [x] Add master trip compliance passport and scan-driven authorized record view
- [x] Add Vitest coverage and responsive validation for the compliance document engine

# Compliance engine gap closure

- [x] Add type-specific tracking-number generation for every listed artifact class
- [x] Add tailgate photo/signature linkage fields and visible review controls
- [x] Add transfer retry state and recipient acknowledgement procedures/UI
- [x] Add structured TDG shipping-document fields and human-review state
- [x] Add a real authorized trip passport view and responsive validation

# Offline-first field records expansion

- [x] Add structured Compliance Vault workspace with searchable artifact objects and provenance metadata
- [x] Add Trip Passport view with driver, unit, location, load, documents, route, disposal, completion, and billing sections
- [x] Add offline quick-share and QR emergency document transfer states without exposing sensitive payloads in QR codes
- [x] Add downloadable offline operating region package with industrial-road attributes and cached field context
- [x] Add driver road observation workflow with GPS/time/vehicle/photo/voice/severity/direction and confidence states
- [x] Add offline routing compatibility summary using vehicle dimensions, GVW, axles, HazMat, clearances, bridges, closures, and seasonal restrictions
- [x] Add sync engine status, conflict-review state, and local event-log presentation
- [x] Add automatic trip report, daily driver package, office report, and missing-document detection
- [x] Add document inbox, smart structured search, controlled transfer tracking, and emergency document access
- [x] Add document integrity metadata, amendments, archive/legal hold controls, and regulatory update center
- [x] Add certified ELD integration boundary and supporting-document package language
- [x] Add Vitest coverage and responsive validation for the offline-first workspace

# Billing, vendor, and unit safety expansion

- [x] Add company-configurable billing rate cards for unit hourly/day rates, jump-hour specialty charges, disposal costs, and specialty equipment charges
- [x] Add job billing calculator with quantities, hours/days, units, disposal, equipment, taxes/adjustments, and auditable line items
- [x] Add vendor directory with contact information, service categories, emergency contacts, coverage area, and availability
- [x] Add unit-level emergency response plans, hazard information, shutdown procedures, required PPE, SDS references, and escalation contacts
- [x] Add remote office maintenance flows for editing rate cards, vendor records, emergency plans, and unit safety information
- [x] Add offline-accessible unit safety snapshot and change/version history
- [x] Add typed persistence and procedures for billing configuration, job charges, vendors, emergency plans, and unit safety records
- [x] Add Vitest coverage for rate calculations and CRUD procedures plus responsive validation

# Billing and unit-safety gap closure

- [x] Persist and render auditable billing line items with taxes and adjustments
- [x] Add update/edit mutations and UI flows for rate cards, vendors, and unit safety plans
- [x] Persist an offline unit-safety snapshot and show real version/change history
- [x] Add billing and unit-safety Vitest coverage and mobile responsive validation

# Dangerous-goods route safety expansion

- [x] Mark dangerous-goods corridors, restrictions, closures, bridge limits, clearance limits, and commercial vehicle constraints clearly on the field map
- [x] Add route constraint inputs for GVW, axle count, height, width, length, HazMat class, quantity, placard status, and vehicle type
- [x] Add constraint-aware route comparison with primary, compliant back-road, and restricted alternatives
- [x] Show risk trade-offs for time, road surface, grade, clearance, bridge rating, seasonal status, truck access, turnaround, and operator exposure
- [x] Persist route decision, selected route, alternatives, constraint snapshot, source/confidence, and driver acknowledgement
- [x] Add route safety warnings and require human review when no route is verified or restrictions conflict
- [x] Add Vitest coverage for route constraint evaluation and responsive map validation

# Route safety refinement pass

- [x] Wire DG corridor and restriction overlays into the existing Google Maps workspace
- [x] Add editable HazMat class, quantity, placard status, and vehicle type inputs
- [x] Add constraint-driven alternative route scoring and structured trade-off rows
- [x] Add explicit no-verified-route and conflict-review states tied to route confidence
- [x] Add route-constraint tests and mobile/tablet validation

# Canada/U.S. disposal directory expansion

- [x] Define a verified-source boundary for disposal sites, regulator registries, facility contacts, acceptance capabilities, and route restrictions
- [x] Add a searchable Canada/U.S. disposal-facility directory with address, coordinates, phone, email, hours, emergency contact, facility type, and jurisdiction
- [x] Normalize facility capabilities for hydrovac slurry, liquid waste, solids, hazardous/DG materials, tanker offload, riser/pad access, and pre-approval requirements
- [x] Distinguish Canadian LSD/grid context from U.S. street-address, county, EPA/state ID, and township/range context
- [x] Add facility-level vehicle/load restrictions, seasonal closures, bridge/clearance notes, back-road access, turnaround limits, and operator risk notes
- [x] Add facility detail cards with source URL, verification date, confidence, last-verified contact, and human confirmation status
- [x] Add route planning that compares verified commercial and lower-risk back-road options without inventing restrictions or facility acceptance
- [x] Add data refresh/import boundary for regulator and facility sources, preserving provenance and historical changes
- [x] Add Vitest coverage and responsive validation for directory search, facility detail, and route safeguards

# Disposal directory refinement pass

- [x] Add normalized email, hours, emergency contact, facility type, jurisdiction, permit/registry ID, and source URL fields
      → `facilities`, `facilityOperatingHours`, `facilityEvidence.sourceUrl`
- [x] Add structured acceptance and restriction fields for waste type, DG class, tanker/riser/pad access, bridge/clearance, seasonal access, and back-road notes
      → `facilityCapabilities`, `wasteStreamVocabulary`, `loadFacilityAssessments`
- [x] Add facility verification status, confidence, last-verified contact, and provenance history UI
      → `facilityEvidence.confidence` / `.reviewState`, `facilityCallAheads`
- [x] Add direct selected-facility handoff into Route Safety and map context
      → `loadFacilityAssessments` → `routeApprovals`
- [x] Add source-refresh boundary and validation tests for facility search/detail/handoff
      → `facilityImportRuns`, `facilitySourceLicences`, `facilityDirectory.db.test.ts`

# Jurisdiction-aware hours-of-service expansion

Built as rules-as-data rather than code. Every seeded figure reads UNKNOWN until
a person verifies it against its clause — that verification is P9 work, tracked
in LEASEOS_CURRENT_STATE.md under "Blocked on things only a person can do", and
is deliberately NOT a checkbox here.

- [x] Add Canada and U.S. driving/on-duty/off-duty cap profiles with jurisdiction and vehicle/load context
      → `hosRuleProfiles`, `hosRuleLimits`
- [x] Add typed persistence and procedures for HOS duty records, exemption determinations, and escalation events
      → `dutyRecords`, `hosAttestations`, `hosRuleLimitHistory`, `hosRouter.ts`
- [x] Add HOS warnings to job dispatch, route safety, trip passport, and compliance readiness views
      → `dispatchEnforcementService.ts`, `compliancePassport.ts`
- [x] Add Vitest coverage for radius/HOS calculations and responsive validation
      → `hos.test.ts`, `hosAttestation.test.ts`, `jurisdiction.test.ts`
- [ ] Verify each seeded HOS figure against its clause (P9 — controller/management only, one figure at a time)
- [ ] Validate Canada and U.S. short-haul, HOS, HazMat, and cross-border assumptions against current official regulator sources
- [ ] Add home-terminal geofence and jurisdiction-aware radius configuration with road/air-mile measurement modes
- [ ] Add daily-return and released-from-duty checks for short-haul eligibility
- [ ] Add daily alternate time-card record with driver, reporting location, report/release times, and total on-duty hours
- [ ] Add full RODS/ELD escalation when radius, daily return, HazMat, emergency, or duty-limit conditions invalidate short-haul status
- [ ] Add logbook workflow with paper-log fallback, amendment/audit history, and office review

# Trip operations / six-month field refinement

- [x] Add first-class round-trip records with odometer/GPS distance and manifest/job/unit/operator links
- [x] Add load/unload stop timing with arrival, setup, operation, completion, departure, wait, quantity, and ticket fields
- [x] Add persistent loading/unloading operating zones with map coordinates, geofences, verification, and source provenance
- [x] Add digital duty records for driving, on-duty, sleeper berth, and off-duty states
- [x] Add mechanic work orders linked to serviceability/inspection context with odometer and engine-hour controls
- [x] Add Trip Operations workspace tying trip events to logbook, manifest, billing, map zones, and maintenance workflows
- [x] Add regression tests for trip distance, timing events, zones, duty records, and work orders
- [x] Add GPS breadcrumb ingestion and automatic geofence arrival/departure detection with driver confirmation
- [x] Add pre-trip critical-defect dispatch block and mechanic release workflow
      → `dispatchEnforcementService.ts`, `dispatchEnforcement.test.ts`
- [x] Add operator document expiry engine for licence, abstract, safety tickets, training, insurance, and medical/other required records where applicable
      → `complianceDocumentValidity.ts`, `documentValidity.test.ts`
- [~] Add site-specific baseline statistics and alerts for unusually long setup/load/unload times
      → engine: `_core/siteBaseline.ts` (13 tests); router + tables outstanding
- [~] Add automatic billing line generation from verified trip distance, billable time, disposal tickets, and approved rate cards
      → engine: `_core/tripBillingProjection.ts`; call site inside the billing path outstanding
- [~] Add automatic manifest/trip passport package generation after completed round trips
      → engine: `_core/tripPassportPackage.ts`; tables + trip-completion decision outstanding
- [~] Add digital safety binder completeness score per unit with office task queue
      → engine: `_core/safetyBinder.ts`; requirement seeding is a P9 question
- [ ] Run a six-month pilot with driver interviews, office feedback, weekly usability reviews, and monthly compliance/process audits
- [ ] Version every workflow change during the pilot so driver feedback can be traced to product decisions
