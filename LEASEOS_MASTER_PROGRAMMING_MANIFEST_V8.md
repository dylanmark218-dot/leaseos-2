# LeaseOS / FieldRoute — Master Programming Manifest V8

**Purpose:** One source of truth for completing LeaseOS from the current `leaseos-fieldroute-v6.zip`, the Trip Operations plan, the Billing/Records Chain, Taxonomy/Routing work, the Integrated Operations checkpoint, and LeaseOS features added across the project.


## V8 checkpoint — authoritative baseline changed

**Authoritative repository for this checkpoint:** `leaseos-fieldroute-v7.zip`

Verified repository state:
- **131 passing tests across 8 core engines** are reported by the B12 checkpoint.
- **12 SQL migrations** are present.
- **52 `mysqlTable(...)` declarations / 52 created tables** are present in the uploaded v7 repository. Earlier notes saying 53 are stale bookkeeping and should not be repeated as the verified repository count.
- B12 adds `routingCompiler.ts` and `routeEvaluation.ts` and closes the prior Segment Evaluation `[BUILD]` item.
- The tare-distribution bug is fixed: vehicle/trailer tare distributes across all axle groups; cargo distributes across load-bearing groups only; modelled axle loads sum to GVW.
- `unknown` is structurally distinct from `review`/`pass`, and unverified but satisfied route constraints return `review`, never `pass`.
- Route verdicts can be reproduced from the stored evidence ledger alone using `reproduceVerdict(...)`.
- `regulatoryThresholds` remains `UNCONFIGURED` / `unverified`; therefore no route may be trusted as fully clear for dispatch until authority-confirmed jurisdiction data is loaded.

### Branch divergence — mandatory prerequisite

The later Integrated Operations files referenced by V7 are **not present in the uploaded v7 repository**:
- `shared/operationsEngine.ts`
- `server/aiSecretary.ts`
- `client/src/pages/OperationsControlCenter.tsx`
- `operationsV2` routes/procedures

Treat those as a **second divergent branch**, not as an available patch. Do not invent or recreate their exact implementation from summaries. To reconcile them faithfully, obtain/upload the branch/ZIP containing those files, diff it against v7, then merge by schema/entity/endpoint responsibility with tests on both sides.

Until that second branch is available:
- continue building from v7 only;
- do not mark the Integrated Operations modules as merged;
- preserve v7 tracking/billing/field-ticket/disposal/taxonomy/routing code as the current trunk;
- avoid creating duplicate tables or competing dispatch/billing models that will make the later reconciliation harder.

---

## Status legend

- **[V7 PRESENT]** — represented in the current attached v7 repository, although some items may still need production hardening or better wiring.
- **[MERGE]** — implemented/spec'd in the later Integrated Operations checkpoint/diff or newer design work, but not present in the attached v6 ZIP and therefore must be ported/merged.
- **[BUILD]** — still requires production implementation, UI wiring, provider/data integration, or end-to-end validation.
- **[VERIFY DATA]** — code may exist, but real-world data/rules must come from current authoritative/licensed sources and must retain provenance. Never convert unknown into “clear”.

---

# 1. Non-negotiable architecture rules

1. **Do not rebuild the repository.** Use v6 as the code trunk and merge later checkpoint work into it.
2. **Job is the root operational record.** Every Trip, Load, Disposal Trip, Field Ticket, Daily Log, Manifest, Billing Book, Permit, Route Decision, Emergency Plan, Evidence Package and Invoice must trace to a Job where applicable.
3. **One fact, one source of truth.** Do not duplicate quantity/time/distance values across tables when a foreign-key reference can preserve the chain.
4. **AI/GPS/OCR propose; people or authoritative systems confirm.**
5. **Unknown is never safe/clear/verified.**
6. **No silent overwrite.** Corrections append an audit/amendment event containing old value, new value, actor, role, timestamp, reason and evidence reference.
7. **Field evidence is not money.** Field-ticket lines record facts and measurements. Rate cards calculate charges later.
8. **Tracking numbers are human references, not database primary keys.**
9. **Every operational artifact gets a canonical tracking number and chain links.**
10. **Regulatory rules are source-versioned data.** Every rule profile needs jurisdiction, authority/source, version, effective date, verification state and last-verified time.
11. **Biometric signing uses device authentication only.** Never store raw fingerprint/face biometric templates.
12. **QR/NFC identifiers are pointers/tokens, not containers for sensitive documents.**
13. **Offline is a first-class workflow, not a visual state.** Mutations must queue locally and reconcile explicitly.
14. **Mechanic release is separate from “work order complete.”** A critical defect cannot disappear merely because a work order status changed.
15. **Production readiness requires full tests, typecheck, migration verification and build after each subsystem.**

---

# 2. Repository merge baseline

## 2.1 Current attached v7

### Trip Operations already represented
**[V7 PRESENT]**

- First-class round trips.
- Odometer/GPS distance.
- Manifest/job/unit/operator links.
- Load and unload stop timing:
  - arrival
  - setup start
  - operation start
  - completion
  - departure
  - waiting time
  - quantity
  - ticket
- Operating zones/geofences with source and verification state.
- Duty records:
  - driving
  - on-duty
  - sleeper berth
  - off-duty
- Mechanic work-order records.
- Trip Operations workspace.
- GPS breadcrumbs.
- Automatic geofence arrival/departure detection with driver confirmation.
- Existing location/unit/operator/document/passport/compliance/billing/routing/disposal work already listed in the v6 TODO.

### V6 Trip Operations gaps still shown by the repository
**[BUILD]**

- Site-specific baseline statistics and alerts for abnormal setup/load/unload duration.
- Automatic billing lines from verified trip distance, time, disposal evidence and rate cards.
- Automatic completed-round-trip manifest/trip-passport package.
- Operator document expiry engine.
- Unit digital safety-binder completeness score and office task queue.
- Pre-trip critical-defect dispatch block plus mechanic release.
- Six-month field pilot instrumentation and workflow versioning.
- Disposal-directory refinement.
- Jurisdiction-aware HOS completion.

## 2.2 Later Integrated Operations branch — reconcile only when its ZIP/source is available

The attached v7 ZIP does **not** contain the later files below. They belong to a separate divergent branch. Do not assume they are available or recreate them from prose; obtain that branch, compare schemas/endpoints/tests, and then merge deliberately.

**[MERGE]**

- `shared/operationsEngine.ts`
- `server/aiSecretary.ts`
- `server/operationsEngine.test.ts`
- `client/src/pages/OperationsControlCenter.tsx`
- integrated schema additions
- `operationsV2` routes/procedures
- Integrated Operations migration changes
- dispatch readiness engine
- authenticated mechanic release
- trailers
- operator qualifications
- first-class permits
- canonical tracking sequence
- multi-load/disposal-trip records
- daily logs/HOS profile boundary
- scoped field tickets and partial acceptance
- billing books and reconciliation
- road-network/map-resource registry
- regulatory rule profiles
- rig assets/moves
- job/location/unit ERPs
- extended print/QR/Nearby Share delivery channels

---

# 3. Canonical operational/evidence chain

The canonical chain must be implemented end-to-end:

`Customer → Job → Dispatch Readiness → Trip → Load → Disposal Trip → Manifest / BOL / DG Shipping Document / Facility Ticket / Scale Ticket → Field Ticket & Signatures → Billing Book → Billing Entry → Invoice → Customer Acceptance/Dispute → Archive`

Parallel chains:

`Job → Route Decision → Road/Bridge/Restriction Evidence → Permit → Driver Acknowledgement`

`Unit → Inspection → Defect → Work Order → Mechanic Release → Dispatch Eligibility`

`Operator → Licence/Qualifications → Duty Records/HOS → Daily Log → Compliance Passport`

`Job/Unit/Location → Emergency Response Plan → Hazards → Muster/Evacuation/Spill/TDG Context`

`Lease/Well → Surface LSD → Downhole LSD/UWI → Manifest → Route → Disposal/Billing`

Every node must have:
- database ID
- human tracking number where it is a tracked artifact
- creator/actor
- timestamps
- provenance/source
- status
- audit/amendment history
- related evidence/attachments
- job/customer/tenant scope

---

# 4. Full Job record

## Job identity
**[V6 PRESENT / MERGE wiring]**

Fields:
- job tracking number
- customer/company
- branch/division
- contract/project
- customer PO
- AFE
- cost centre
- charged-to UWI/LSD
- dispatch source
- requested start/end
- service category
- job status
- priority
- internal notes
- customer instructions
- emergency contact
- customer representative/company-man contact

## Classification
**[MERGE / BUILD UI]**

Use the 12-dimension taxonomy:

1. service
2. truck
3. trailer
4. cargo
5. environment
6. radius/distance regime
7. load method
8. unload method
9. regulatory context
10. qualifications
11. documents
12. billing

One classification must derive:
- routing restriction layers
- permit review
- licence/endorsement review
- operator qualifications
- PPE
- pre-trip additions
- TDG/shipping-document requirements
- safety documentation
- billing units/rate-card categories

Do not create a giant job-title dropdown as the core taxonomy.

---

# 5. Operator identity and qualification system

## Operator profile
**[V7 PRESENT]**

- operator ID
- user/account link
- role:
  - driver/operator
  - mechanic
  - dispatcher
  - office
  - manager/admin
- licence class
- licence number
- licence expiry
- abstract
- insurance where applicable
- emergency contact
- training/certifications
- medical/other company-required records where applicable
- document wallet
- OCR review state
- expiry warnings

## Qualification engine
**[MERGE / BUILD UI]**

Qualification records must support:
- TDG
- site/customer orientations
- H2S or other site requirements
- equipment-specific training
- air-brake/vehicle endorsements where applicable
- company-specific qualifications
- issue date
- expiry
- source document
- verification status

Dispatch must block or review according to company/jurisdiction policy when a required qualification is missing/expired/unverified.

---

# 6. Unit and trailer passports

## Unit passport
**[V7 PRESENT]**

- unit number
- VIN
- plate
- make/model/year
- equipment configuration
- GVWR
- axle configuration
- dimensions
- tank/body capacity
- unit type
- QR/NFC-ready random identifier
- insurance
- registration
- inspection
- permits
- emergency plan
- maintenance status
- defect history
- trip/load/disposal history
- signatures
- unit documents
- odometer/engine/PTO context

## Trailer passport
**[MERGE]**

- trailer number
- VIN
- plate
- trailer type
- GVWR
- axle count/groups
- dimensions
- inspection status
- maintenance status
- insurance expiry
- permits/documents
- unit/job assignment history

## Meter system
**[BUILD/MERGE from spec]**

Track:
- odometer
- engine hours
- PTO hours
- pump hours
- vacuum hours
- idle hours

Each reading needs:
- timestamp
- source
- actor/device
- provenance
- correction history

Maintenance schedules must be able to use the correct meter, not mileage only.

---

# 7. Dispatch Readiness Gate

## Server-side gate
**[MERGE]**

No UI-only bypass.

Evaluate:

1. unit inspection
2. unit maintenance
3. unit insurance
4. trailer inspection
5. trailer maintenance
6. trailer insurance
7. operator licence expiry
8. unresolved critical defects
9. critical work-order mechanic release
10. permits and effective/expiry dates
11. required qualifications

## Extended operational review
**[BUILD]**

Also surface, without inventing legality:
- load classification verified?
- required TDG/shipping document ready?
- placard requirement reviewed?
- receiving/disposal facility acceptance verified?
- route restrictions reviewed?
- route data stale/unknown?
- ERP available offline?
- required customer/site documentation loaded?
- field ticket policy known?
- HOS eligibility/status known?

Statuses:
- READY
- READY WITH REVIEW
- BLOCKED
- UNKNOWN / DATA REQUIRED

Every assignment attempt writes an audit event:
- driver
- unit
- trailer
- job
- blockers
- reviewer
- timestamp
- decision

---

# 8. Mechanic defect/work-order/release workflow

## Driver defect capture
**[V7 PRESENT]**

Input via:
- pre-trip
- post-trip/DVIR
- voice
- photo
- office entry

Fields:
- driver’s exact words
- affected system
- recurrence
- photo/evidence
- timestamp/location/unit
- severity proposal
- source/provenance

AI may classify/rout the report but must never diagnose the defect.

## Work order
**[V6 PRESENT / MERGE release]**

- tracking number
- unit
- linked defect
- severity
- assigned mechanic
- odometer
- engine/PTO hours
- findings
- corrective action
- parts
- labour
- repair notes
- test notes
- status

## Return to service
**[MERGE]**

For critical items:
- authenticated mechanic/admin only
- technician identity
- release timestamp
- repair notes
- test/road-test notes
- return-to-service status
- linked defect resolution
- audit event
- dispatch eligibility recalculation

---

# 9. Trip Operations state machine

## Trip
**[V7 PRESENT]**

Fields:
- trip tracking number
- job
- trip type
- operator
- unit
- trailer
- other accompanying units
- origin
- destination
- route decision
- load/manifest
- odometer start/end
- GPS distance
- start/end times
- status
- offline/sync state

Suggested states:
- draft
- dispatched
- travelling_to_load
- arrived_load
- setup_load
- loading
- loaded
- travelling_to_unload
- arrived_unload
- setup_unload
- unloading
- empty
- return/deadhead
- completed
- awaiting_documents
- held_for_review

## Stop/event model
**[V7 PRESENT]**

Each load/unload/service stop:
- stop type
- sequence
- geofence
- arrival
- setup start
- operation start
- operation complete
- departure
- wait minutes
- setup minutes
- operation minutes
- quantity
- quantity unit
- measurement method
- ticket
- delay reason
- notes
- source/provenance

## Event principle
Every driver tap or confirmed automated event writes one event. Derived screens read those events instead of asking the driver to re-enter the same time.

---

# 10. GPS, geofences and field observations

## GPS
**[V7 PRESENT]**

- breadcrumbs
- accuracy
- timestamp
- trip
- unit/operator
- zone-enter/exit proposals
- driver confirm/reject
- rejected proposal retention

## Zone engine
**[V7 PRESENT]**

Use for:
- lease entrance
- load zone
- unload/disposal zone
- yard
- home terminal
- water fill
- scale
- washout
- staging
- emergency/muster zones

Rejected proposals must remain available for zone-quality statistics.

## Site baseline analytics
**[BUILD]**

Compute per-site:
- queue time
- setup time
- load/unload time
- turnaround
- rejection rate
- GPS confidence
- time-of-day patterns

Alert on abnormal durations but never silently convert anomaly detection into a billing fact.

## Driver observation system
**[V6 PRESENT; harden]**

Observation types:
- washout
- flooding
- ice
- mud
- construction
- road damage
- low clearance
- closed gate
- posted weight
- no turnaround
- truck stuck
- radio dead zone
- no cellular
- map-position error
- other

Attach:
- GPS
- time
- direction
- unit/load state
- photo
- voice note
- confidence
- approval/community confirmation status

---

# 11. Lease/well/LSD identity

**[V7 PRESENT]**

Support:
- surface LSD
- downhole LSD
- UWI/API-equivalent
- well licence
- operator
- field
- province/state
- access road
- gate instructions
- hazards
- emergency context
- coordinates
- source
- last verified

Map surface and downhole separately.

Manifest and trip passport must link both when applicable.

---

# 12. Load / material / TDG system

## Load record
**[V6 PRESENT / MERGE multi-load]**

Fields:
- load tracking number
- job/trip
- sequence
- material
- quantity/unit
- measurement method:
  - meter
  - scale
  - gauge
  - estimate
  - customer stated
  - unknown
- source/provenance
- load location
- destination
- SDS reference
- photos
- ticket references
- verification state

## Dangerous-goods assistant
**[V6 PRESENT concept; production data verification required]**

Driver may describe material by voice/text.

AI may return candidate:
- shipping name
- UN number
- class/division
- subsidiary class
- packing group
- placard candidate
- label candidate
- SDS source link/reference
- ERAP/ERI/ERG context where applicable

But:
- classification must remain pending until verified
- do not invent a UN number
- do not certify legal compliance
- do not treat model output as current law
- keep regulatory profile/source/version/effective date
- physical placard/label check remains part of pre-trip

---

# 13. Manifest and shipping-document master record

## Manifest identity

Every manifest requires:
- manifest tracking number
- version
- job
- trip
- load(s)
- generator/shipper
- origin
- surface LSD
- downhole LSD/UWI where relevant
- destination/facility
- operator/driver
- unit
- trailer
- other participating units where relevant
- route decision
- permit references
- dispatch event
- issue/close timestamps
- status

## Material section

- material/common name
- regulatory/shipping description
- quantity
- quantity unit
- measurement method
- density/weight where relevant and sourced
- SDS
- TDG/DG review state
- UN/class/packing group candidate + verification
- placard/label review
- ERAP/ERI/ERG references where required/available
- waste classification
- generator/customer references

## Chain-of-custody section

- loading stop
- load ticket
- BOL
- DG shipping document
- tailgate/JSA
- driver acknowledgement
- GPS confirmation
- departure
- route decision
- scale ticket
- facility ticket
- disposal ticket
- receiving acknowledgement
- photos
- signatures
- amendments

## Completion

Completed round trip should automatically build a Trip/Manifest Passport containing:
- operational timeline
- all tracking numbers
- manifest
- BOL/load ticket
- TDG shipping document where applicable
- route/permit evidence
- GPS confirmation
- scale/disposal evidence
- field ticket
- customer signature/response
- DVIR
- daily log/HOS supporting documents
- relevant photos
- audit/amendments
- billing evidence links

**[BUILD]** Automatic final package generation still needs production implementation.

---

# 14. Tailgate / JSA / safety meetings

**[V7 PRESENT]**

Every record:
- tracking number
- job/location
- date/time
- leader
- participants
- units
- hazards
- controls
- PPE
- H2S/site/weather/wind/traffic notes where relevant
- voice transcript/review state
- photos
- signatures
- amendments
- source/provenance

AI Secretary can extract candidates but requires read-back and confirmation.

---

# 15. Emergency response system

## ERP objects
**[MERGE / V6 unit-safety overlap]**

ERPs can attach to:
- job
- location/lease/well
- unit
- load/material
- customer/site

Fields:
- tracking/version
- hazards
- shutdown procedures
- emergency steps
- evacuation route
- muster point
- emergency contacts
- customer/site contacts
- fire/EMS/emergency service references
- spill response
- TDG/DG context
- SDS references
- PPE
- first aid/rescue considerations
- source
- effective date
- last verified
- offline snapshot status

## Map
Show:
- muster points
- emergency services
- site exits
- staging
- known dead zones
- verified emergency access routes

Never claim an ERP is current if its source/version has not been verified.

---

# 16. Commercial vehicle routing and back-road mapping

## Routing input profile
**[Taxonomy engine built in later work; merge/integrate]**

- unit/trailer type
- GVW
- axle groups
- modelled loaded axle weights
- manufacturer ratings
- measured weights where available
- height
- width
- length
- cargo/DG class
- permit state
- environment
- surface type
- destination/site

## Restriction layers

- truck-route legality/status
- weight
- axle limits
- bridges
- clearances
- width
- length
- oversize corridor
- DG corridor
- seasonal road bans
- gravel/private/lease roads
- lease access
- turnaround capability
- school zones
- residential sensitivity
- traffic
- turn risk
- grade
- construction/closures
- driver observations
- cellular coverage
- radio coverage

## Resource layers

- fuel/cardlock
- DEF
- water fill
- disposal
- scales/weigh stations
- truck parking
- washout
- repair
- tire service
- rigs
- wells/leases
- staging
- emergency services
- muster points
- CB/two-way/repeaters

## Segment evaluation
**[V7 PRESENT — B12]**

`routingCompiler.ts` expands only applicable restriction layers into concrete checks. `routeEvaluation.ts` evaluates supplied road segments and records an evidence ledger. For every candidate segment:
- PASS
- REVIEW
- BLOCKED
- UNKNOWN

B12 guarantees:
- unknown cannot be absorbed by a neighbouring pass;
- a satisfied limit from an unverified source returns `REVIEW`, not `PASS`;
- legal / physical feasibility / operational preference / data confidence remain separate axes;
- the stored evidence ledger contains the actual vehicle value, limit value, unit, source, version, verification date and confidence;
- `reproduceVerdict(evidence[])` can reproduce the same verdict/explanation without map access;
- route-profile changes invalidate dependent route decisions.


Explain each result:
- rule checked
- unit/load input
- segment constraint
- source
- verification date
- confidence
- permit override/condition if applicable

## Real routing graph
**[BUILD]**

B12 evaluates supplied segments; it does **not** yet persist a road graph or choose paths. Add:
- real road geometry
- commercial routing-provider or licensed road graph integration
- offline route packages
- rerouting
- selected-route persistence
- route-decision audit
- route-version snapshot at dispatch

---


## Routing dispatch gate — current hard stop

B12's compiler/evaluator is present, but dispatch-grade routing is still gated by authoritative data. `regulatoryThresholds` currently ships as `UNCONFIGURED` / `unverified`. Therefore:
- no route should be labelled fully clear for dispatch from current placeholder thresholds;
- oversize/overweight triggers must be loaded per jurisdiction with authority source, effective date and verification status;
- bridge/road/municipal rules need the same provenance discipline;
- permit conditions override route recommendations;
- unverified satisfied constraints remain `review`.

This is a data-governance gate, not an engine-code gap.

---

# 17. Permits and regulatory profiles

## Permit object
**[MERGE]**

- tracking number
- job
- unit
- trailer
- permit type
- jurisdiction
- status
- effective date
- expiry
- approved route
- conditions
- issuing/source reference
- source verification time
- attachment
- superseded/revoked history

Re-evaluate permits when:
- truck changes
- trailer changes
- load changes
- dimensions/weight change
- route changes

Permit conditions override app recommendations.

## Regulatory rule registry
**[MERGE / VERIFY DATA]**

For:
- HOS
- TDG
- weights
- axle limits
- bridges/clearance
- oversize/overweight
- municipal truck routes
- DG routes
- safety requirements
- retention rules

Store:
- jurisdiction
- authority
- source URL/reference
- version
- effective date
- last verified
- verification state
- payload/rule data
- superseded date

No source/version = untrusted and visible warning.

---

# 18. Hours of Service / ELD / daily logs

## Base records
**[V6 PRESENT / MERGE stronger engine]**

Duty states:
- driving
- on duty
- sleeper berth
- off duty
- other jurisdiction-supported states

Sources:
- driver
- GPS/device proposal
- imported ELD
- office correction
- system

Status:
- pending
- confirmed
- amended
- rejected

## HOS rule engine
**[MERGE / BUILD current official profiles]**

Must be jurisdiction-aware and source-versioned. Support:
- Canada
- U.S.
- cross-border regime determination
- short-haul/radius rules
- road-mile/air-mile mode where required
- home-terminal geofence
- daily return/release checks
- HazMat/DG context
- emergency/exemption context
- full RODS escalation
- paper-log fallback
- amendments
- office review

Do not hard-code one universal 11/14 rule.

## Integrations
**[BUILD]**

- certified ELD boundary
- import/export adapter
- paper-log reconciliation
- supporting-document package
- dispatch/route/trip-passport HOS warning
- end-of-day daily log
- driver signature
- office exception queue

---

# 19. Commercial fuel / DEF / water-fill network

## Registry
**[MERGE schema/resource type; BUILD data/import/UI]**

Fuel/cardlock fields:
- location
- brand/operator
- truck access
- diesel
- DEF
- cardlock/payment network
- hours
- phone
- heavy-vehicle access notes
- clearance/turnaround
- parking
- washroom/amenities where known
- source/verification

Water-fill:
- location
- source/operator
- hours
- access
- truck compatibility
- potable/non-potable classification only if sourced
- contact
- price/permit where applicable
- source/verification

Routing should show distance/time impact and offline cached availability, while preserving stale/unknown state.

---

# 20. CB / two-way radio / communications layer

**[MERGE registry; BUILD actual dataset/UI]**

Store only lawfully sourced/authorized information:
- channel/frequency label where appropriate
- system/repeater
- coverage area
- road/site
- operator/owner
- access restrictions
- emergency-use notes
- last verified
- source

Driver observations:
- “radio lost here”
- channel/site worked
- dead zone
- repeater reach

Do not invent frequencies or imply permission to transmit.

Map also includes:
- cellular coverage state
- no-service zones
- offline document availability

---

# 21. Disposal directory and disposal-trip chain

## Facility directory
**[V6 PRESENT, refinement still open]**

Normalize:
- facility name
- facility type
- jurisdiction
- permit/registry ID
- address
- coordinates
- phone
- email
- hours
- emergency contact
- source URL/reference
- last verified
- confidence
- acceptance verification

Capabilities/restrictions:
- hydrovac slurry
- liquid waste
- solids
- DG/hazardous materials
- tanker offload
- riser/pad access
- pre-approval
- vehicle size/weight
- bridge/clearance
- seasonal access
- back-road notes
- turnaround

## Disposal Trip
**[MERGE]**

Each disposal trip gets:
- tracking number
- job/trip/load
- operator
- unit/trailer
- facility
- material
- quantity
- measurement method
- arrival/departure
- scale
- manifest
- facility ticket
- disposal ticket
- receiving acknowledgement
- washout
- photos
- notes
- closeout state

## Closeout engine
**[MERGE]**

Requirement-aware checks. A document that does not apply must be `not_required`, not “missing”.

Missing facility evidence should hold the disposal charge, not unrelated accepted service charges.

---

# 22. Field ticket and customer/company-man sign-off

## Ticket scope
**[MERGE]**

Supported:
- job
- trip
- load
- service_event

Customer config chooses default; actual service may allow authorized override.

## Lines
Facts only:
- service
- duration
- quantity
- unit
- equipment extra
- standby
- mileage
- pump/PTO hours
- second operator
- washout
- specialty equipment
- measurement method
- source evidence

## Per-line customer response
- pending
- accepted
- disputed
- rejected
- modified

Accepted lines can proceed while disputed lines go to review.

## Signer
Captured identity:
- name
- company
- role
- phone/contact
- signature
- captured offline
- time/location

Signer is not forced to be a system user.

## Signature integrity
- payload hash
- exact scope statement
- timestamp
- amendments after signature trigger review
- refusal reason retained
- unavailable-on-site state retained
- re-presentation supported

## Biometric-assisted signing
Use device authentication to authorize the signing action. Store the signature event—not raw biometrics.

**[BUILD]** Production customer/company-man signature UI must be backed by the field-ticket tables.

---

# 23. Tracking-number system

**[MERGE / Billing chain engine built in later work]**

Tracked artifact classes should include:
- JOB
- TRIP
- LOAD
- DISPOSAL
- MANIFEST
- BOL
- TDG/DG document
- TAILGATE/JSA
- FIELD TICKET
- DAILY LOG
- DVIR
- DEFECT
- WORK ORDER
- MAINTENANCE
- PERMIT
- PHOTO PACKAGE
- DELIVERY/TRANSFER
- BILLING BOOK
- INVOICE
- INCIDENT
- RIG MOVE
- ERP

Format is company configuration:
- prefix
- branch
- year digits
- month segment
- separator
- padding
- reset period
- migration start number

Concurrency:
- transactional sequence issuance
- row lock or equivalent
- unique tracking-reference index as backstop
- database-backed parallel issuance test

Master search:
tracking number → resolve object → walk backward to Job and forward to Invoice/Archive.

---

# 24. Billing Book and automatic billing

## Billing book
**[MERGE]**

Auto-create with Job.

Fields:
- customer
- job
- AFE
- PO
- cost centre
- charged-to UWI
- rate-card version
- customer billing config
- status
- blockers
- reconciliation state

## Rate cards
**[V7 PRESENT]**

Support:
- hourly
- day
- mileage
- per load
- disposal
- standby
- jump/specialty hours
- hose/equipment extras
- second operator
- pump/PTO time
- washout
- specialty equipment
- taxes/adjustments

## Automatic billing line generation
**[BUILD]**

Generate only from confirmed/verified evidence:
- trip events
- confirmed distance
- scale/meter measurements
- verified disposal records
- accepted field-ticket lines
- approved rate card
- confirmed extras

Never generate money from pending voice/OCR/GPS candidates.

## Billing readiness gates
Implement named blockers:
- trips complete
- required load tickets
- disposal evidence verified
- no unconfirmed billing-critical values
- daily logs complete
- rate card
- AFE/PO/cost coding
- required field-ticket response
- amendments after signature
- required customer configuration

Do not display generic “incomplete”; name the exact missing item.

## Snapshot
At invoice finalization store:
- source facts JSON
- calculated lines JSON
- rate-card version
- payload hash
- creation time

This preserves “why was this amount billed?” even after operations data changes.

---

# 25. Invoice / customer acceptance / disputes

**[MERGE/BUILD production UI]**

Invoice lifecycle:
- draft
- ready
- sent
- viewed
- accepted
- partially accepted
- disputed
- resubmitted
- paid/closed

Fields:
- invoice tracking number
- billing snapshot
- recipient
- sent time
- viewed time
- acceptance token
- dispute reason
- external portal reference
- evidence package
- accepted/disputed lines
- resubmission history

External portal adapter boundary:
- OpenInvoice/Cortex or customer-specific portals where required
- do not couple core billing logic to one portal

---

# 26. Document vault, compliance passports and delivery

## Artifact vault
**[V7 PRESENT]**

Support search by:
- tracking number
- job
- trip
- driver
- unit
- trailer
- lease/well/LSD/UWI
- manifest
- facility
- invoice
- date
- document type

## Expiry engine
**[BUILD]**

Compute:
- current
- expiring
- expired
- missing
- rejected/unverified

For:
- driver licence
- abstract
- training/safety tickets
- insurance
- unit insurance
- registration
- annual inspection
- trailer documents
- permits
- qualifications
- customer/site requirements

## Unit safety binder completeness
**[BUILD]**

Per unit:
- percent complete
- exact missing documents
- exact expired documents
- assigned office task
- dispatch consequence

## Delivery channels
Core model supports:
- email
- portal
- API
- download
- print
- QR
- Nearby Share / local share

**[BUILD production integration]**
- PDF renderer
- print layout
- email provider
- secure-link delivery
- QR verification endpoint
- offline queued-send worker
- delivery retries
- recipient acknowledgement
- message/provider ID
- delivery audit trail

---

# 27. Offline-first architecture

## What must become real offline operation
**[BUILD/harden]**

- service worker/PWA
- IndexedDB/local durable store
- cached assigned jobs
- cached trips/stops
- cached route geometry/constraints
- cached facilities
- cached fuel/water/radio resources
- cached ERPs/SDS/critical documents
- local evidence/photo queue
- local voice transcript queue
- local field-ticket signature queue
- local daily-log queue
- local document-send queue
- visible local-save state
- retry/backoff
- conflict detection
- no silent auto-merge of material conflicts
- server reconciliation
- audit events for conflict resolution

Pre-departure package:
- route
- leases/wells
- destination
- facilities
- fuel/water
- comms
- ERP
- permits
- documents
- rate/customer workflow
- map tiles/road context

Quick share must work from cached artifacts when cellular service is unavailable.

---

# 28. AI Secretary

## One engine, many form definitions
**[MERGE backend boundary / BUILD driver UI]**

Forms:
- trip
- load
- unload
- disposal
- manifest
- field ticket
- daily log
- tailgate/JSA
- pre-trip/post-trip
- defect
- maintenance note
- incident/near miss
- fuel
- expense
- billing candidate
- end-of-day closeout

Pipeline:
`voice/text → transcription → form/intent → schema-constrained extraction → per-field provenance → gaps → minimum questions → read-back → driver confirm/edit/reject → commit`

Every extracted value:
- value
- exact/approximate
- source utterance
- confidence
- pending/confirmed/rejected
- corrected-from reference

Examples the engine should support:
- arrival/wait/setup/load/unload times
- quantity + measurement method
- odometer
- fuel quantity/site/card reference
- trailer change
- equipment issue
- tailgate attendees/hazards
- road condition
- customer route instruction
- near miss
- radio dead zone
- standby
- extra hose
- second operator
- pump hours
- AFE/PO/cost code
- washout
- specialty equipment

Hard boundaries:
- no diagnosis
- no automatic TDG certification
- no legal-route approval
- no HOS compliance certification
- no customer acceptance inference
- no vehicle release
- no billable amount creation from unconfirmed values

**[BUILD]**
- microphone UI
- offline transcript queue
- review/edit screen
- form-target selection
- source utterance highlighting
- office review queue

---

# 29. Exception Centre

**[BUILD / partial prototype]**

One aggregation endpoint for all items needing human action.

Categories:
- missing trip documents
- expiring licences
- expiring training
- expiring insurance
- expired inspections
- unresolved defects
- unreleased critical work orders
- permits expiring/revoked
- missing qualifications
- unconfirmed GPS/AI/OCR values
- incomplete daily logs
- missing disposal evidence
- disposal/facility acceptance review
- invoice blockers
- abnormal site turnaround
- stale route/regulatory data
- sync conflicts
- failed document delivery
- unresolved customer disputes

Each item must deep-link directly to the fix.

---

# 30. Roles and permissions

**[BUILD/harden]**

Roles:
- driver/operator
- mechanic
- dispatcher
- office
- manager
- admin
- optional auditor/read-only
- optional customer secure-link viewer

Rules:
- dispatch assignment requires dispatch authorization
- critical mechanic release requires mechanic/admin
- office correction requires reason
- manager authorization for defined billing exceptions
- QR/passport view is role-scoped
- customer secure link sees only shared package
- cross-customer/tenant isolation enforced server-side
- every privileged action audited

---

# 31. Rig moves and specialized operations

**[MERGE / BUILD UI]**

Rig asset:
- identity
- location
- operator/customer
- dimensions/weights
- status

Rig movement:
- tracking number
- source/destination
- unit/trailer assignments
- manifest
- permit refs
- route decision
- start/end
- status
- evidence/photos
- customer sign-off
- billing links

Reuse the same route/permit/dispatch/evidence architecture instead of creating a separate standalone app.

---

# 32. External data ingestion and provenance

**[BUILD / VERIFY DATA]**

Priority authoritative/licensed imports:
1. Canadian/provincial HOS/TDG/permit/weight rules
2. Alberta and other operating-jurisdiction road restrictions
3. bridge/clearance/axle/seasonal-ban data
4. municipal truck routes
5. municipal dangerous-goods routes
6. construction/closures
7. school/residential restrictions
8. fuel/cardlock/DEF
9. water fill
10. disposal/transfer/treatment
11. scales/weigh stations
12. washout/parking/repair/tire
13. radio/repeater information where lawfully available
14. lease/rig/well access and land-description data
15. emergency services/site ERP resources

Every import batch:
- source
- URL/reference
- licence/usage notes
- jurisdiction
- resource type
- effective date
- imported date
- record count
- checksum
- validation status
- coverage measure
- freshness measure

Never claim “complete” coverage until measured.

---

# 33. Production UI screens to finish/wire

## Driver
- Current Job
- Dispatch Readiness
- Trip Timeline
- Confirmations
- AI Secretary
- Load
- Unload
- Manifest
- Field Ticket & Sign-off
- Daily Log/HOS
- Field Map
- Route Review
- Report Road Condition
- Pre-trip
- Post-trip/DVIR
- Unit Passport
- Lease/Well Passport
- Document Vault
- Emergency Plan
- Quick Share
- End-of-day Closeout

## Mechanic
- Defect Queue
- Work Orders
- Unit Passport
- Meter/Service History
- Mechanic Release
- Parts/Labour/Tests
- Blocked-unit history

## Dispatcher/Office
- Exception Centre
- Jobs
- Dispatch Board
- Crew/Unit/Trailer Assignment
- Tracking Search
- Job Classification
- Trips/Multi-loads
- Disposal Closeout
- Disposal Reconciliation
- Field-Ticket Reconciliation
- Billing Book
- Rate Cards
- Invoices/Acceptance/Disputes
- Documents/Expiry
- Disposal Directory
- Fuel/Water/Comms Resources
- Route/Permit Review
- Rig Move Board
- ERP Management
- Regulatory Source Review
- Map Import Review
- Audit Log
- Feedback Queue

## Admin
- Numbering/Sequences
- Customer Billing Config
- Roles/Permissions
- Operating Zones
- Map Data Sources
- Regulatory Profiles
- Document Retention/Legal Hold
- Sync/Offline
- Integration Settings
- External Portals
- Email/Delivery Provider
- Audit/tenant controls

---

# 34. Six-month pilot instrumentation

**[BUILD before pilot]**

Capture:
- time to complete each workflow
- taps/actions per workflow
- office correction rate
- missing-document rate
- billing hold reasons
- dispute rate
- driver confirmation/rejection rate
- geofence rejection rate
- route warning frequency
- site turnaround baselines
- failed delivery/sync rates
- defect-to-release duration
- driver feedback by screen
- resulting product change/version

Pilot cadence:
- driver interviews
- office feedback
- weekly usability review
- monthly compliance/process audit
- every workflow change versioned and linked to the feedback/change request

---

# 35. Testing and verification gates

Before declaring a subsystem complete:

1. install dependencies
2. run TypeScript check
3. run pure tests
4. run DB/integration tests
5. run production build
6. generate/review Drizzle migration
7. migrate disposable/test DB
8. test rollback/backfill plan where relevant
9. exercise mobile/tablet/desktop UI
10. test offline/reconnect
11. test permissions
12. test audit/amendment behavior
13. append checkpoint

Mandatory integration tests:
- dispatch rejection server-side
- mechanic release authorization
- permit/qualification expiry behavior
- tracking-number concurrency
- database transaction rollback
- multi-load/disposal chain
- field-ticket partial acceptance
- amendment after signature
- invoice blocker naming
- customer/tenant isolation
- QR role scoping
- document delivery retry/acknowledgement
- sync conflicts
- HOS source/version rejection
- route unknown != clear
- AI/OCR/GPS pending != confirmed

---

# 36. Migration order from current v6

## Stage A — Stabilize v7 and prepare branch reconciliation
1. Branch current v7.
2. Install and run baseline `pnpm test`, `pnpm check`, `pnpm build`.
3. Record the v7 baseline: B12 routing compiler/evaluator, 12 migrations, verified schema count, and current test inventory.
4. Do **not** merge Integrated Operations until its actual ZIP/source is available.
5. When that branch arrives, generate a bidirectional diff: schema, migrations, core engines, routers, UI, tests and shared types.
6. Build one reconciliation migration plan before copying code, so duplicate tables/enums/route procedures are not introduced.
7. Merge subsystem-by-subsystem and keep both branches' tests green after each merge.
8. Re-run full suite/build and create a checkpoint.

## Stage B — Close Trip Operations gaps
1. site baselines
2. automatic verified billing candidates
3. automatic trip/manifest package
4. expiry engine
5. safety-binder completeness
6. production dispatch gate
7. production mechanic release

## Stage C — HOS/daily log
1. current authoritative rule-source profiles
2. home-terminal/radius
3. duty-state engine
4. RODS/ELD escalation
5. paper fallback
6. office review
7. dispatch warnings

## Stage D — Mapping/data
1. road geometry/provider
2. segment evaluator
3. authority-sourced bridge/weight/clearance
4. municipal truck/DG routes
5. permits
6. fuel/DEF/water/disposal/scales
7. radio/repeaters
8. emergency resources
9. offline region packages

## Stage E — Documents and sign-off
1. field-ticket customer UI
2. PDF generation
3. printing
4. email/secure links
5. QR verification
6. Nearby/local share
7. offline queued-send
8. recipient acknowledgement

## Stage F — AI Secretary
1. microphone
2. transcript
3. schema extraction
4. per-field provenance
5. read-back
6. driver edit/confirm
7. offline queue
8. office review

## Stage G — Billing/invoice
1. Billing Book UI
2. evidence-linked automatic lines
3. readiness gate
4. snapshot
5. invoice
6. acceptance/dispute
7. portal adapter

## Stage H — Pilot hardening
1. exception centre
2. feedback metrics
3. workflow versioning
4. security/tenant tests
5. performance
6. backup/restore
7. pilot deployment

---

# 37. Definition of “LeaseOS complete enough for field pilot”

Do **not** call LeaseOS field-pilot ready until a driver can complete this entire chain without paper duplication:

1. authenticate
2. open assigned Job
3. pass dispatch readiness
4. see operator/unit/trailer/permit/ERP readiness
5. download offline route/document package
6. navigate to the correct lease/well using surface/downhole identity
7. confirm arrival
8. complete tailgate/pre-trip/site requirements
9. load material and confirm classification evidence
10. capture quantity/ticket
11. generate/update manifest
12. travel on reviewed commercial route
13. record duty status
14. arrive at disposal/receiver
15. capture scale/facility/disposal evidence
16. close disposal trip
17. obtain customer/company-man field-ticket response/signature
18. complete post-trip/DVIR
19. close daily log
20. run “what am I missing?”
21. generate final Trip/Manifest Passport
22. queue/send required documents
23. sync after reconnect
24. office sees only named exceptions
25. accepted evidence becomes Billing Book entries
26. invoice package traces every charge back to source evidence
27. amendments never erase original facts

---

# 38. Instruction block for Claude / Manus

Use the current `leaseos-fieldroute-v7.zip` repository as the source of truth. Do not rebuild the app from scratch and do not discard existing working features.

First inspect and baseline the current v6 code with install, tests, TypeScript check and production build. Then merge the later Integrated Operations checkpoint capabilities into v6: `operationsEngine`, `aiSecretary`, `operationsV2`, dispatch readiness, authenticated mechanic release, trailers, qualifications, permits, multi-load/disposal records, daily logs/HOS source profiles, scoped field tickets, billing books, regulatory/map-resource models, rig moves and emergency response plans.

After the merge, implement the remaining modules in the order defined in this manifest. The full target is an evidence-led oilfield/commercial transportation operating system where Job → Trip → Load → Disposal → Field Ticket → Billing → Invoice is one traceable chain.

Never hard-code or invent current regulations, road restrictions, TDG classifications, radio frequencies, fuel/water/disposal availability, facility acceptance or route legality. Build provenance-aware source/import registries. Unknown must remain unknown. AI, GPS and OCR may propose values but cannot silently certify TDG/HOS compliance, legal route approval, vehicle safety/release, customer acceptance or billable amounts.

Every subsystem must include:
- schema/migration
- typed backend procedures
- role authorization
- responsive production UI
- offline behavior where field use requires it
- provenance
- append-only audit/amendment history
- tracking-number linkage
- tests
- TypeScript check
- production build
- checkpoint report

After each subsystem append a checkpoint containing:
- files changed
- schema/migrations
- endpoints
- screens
- test counts before/after
- build/typecheck result
- screenshots/screen count where applicable
- remaining gaps
- any external dataset still unverified

Do not mark a feature complete merely because a prototype screen exists. It is complete only when the database, backend, UI, authorization, evidence chain, offline behavior (where needed), tests and production build all work together.
