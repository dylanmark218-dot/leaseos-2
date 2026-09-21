# LeaseOS — Feature & Backend Specification

**Companion to:** `leaseos-prototype.html` (clickable UI) and `LEASEOS_BUILD_PLAN.md` (audit + phasing).
**Purpose:** freeze the UI contract so every backend endpoint is built once, against a known shape.

The prototype uses real `drizzle/schema.ts` field names throughout. Where the prototype shows a
field that has no column yet, it's listed below as **NEW**.

---

## 1. Cross-cutting: the provenance type

Four subsystems independently invented the same idea (`zoneEvents.confidence`,
`complianceDocuments.verificationStatus`, `routeContexts.confidence`,
`loadProfiles.classificationStatus`). Unify them before building anything else — every screen in
the prototype renders this same chip, so one type change propagates everywhere.

```ts
type Provenance = {
  source: 'driver_stated' | 'driver_voice' | 'gps' | 'photo_ocr'
        | 'system_inferred' | 'imported' | 'human_corrected';
  confidence: 'low' | 'medium' | 'high';
  precision?: 'exact' | 'approximate';   // "around eight" ≠ 08:00:00
  status: 'pending' | 'confirmed' | 'rejected' | 'unknown';
  verifiedAt?: Date; verifiedBy?: number;
};
```

**UI rule the prototype enforces:** anything not `confirmed` renders amber with a dashed underline,
everywhere it appears. A value can never look settled on one screen and provisional on another.

**Rule for every automation, without exception:** propose → show evidence and confidence → wait for
a human → commit with provenance. The GPS engine already works this way. AI extraction, OCR,
auto-billing and predictive maintenance must follow the same shape.

---

## 2. Screen → backend map

Legend: ✅ exists · ⚠️ partial · ❌ missing

### Field (driver)

| Screen | Entities | Endpoints | State |
|---|---|---|---|
| Current job | `trips`, `tripStops`, `jobs` | `trips.list/update`, `tripStops.create/update` | ⚠️ needs job link |
| Trip timeline | `tripStops`, `zoneEvents`, `tripBreadcrumbs` | `tripStops.list`, `gps.zoneEvents` | ✅ |
| **Confirmations** | `zoneEvents`, **NEW** `pendingValues` | `gps.pendingZoneEvents`, `gps.confirmZoneEvent` | ⚠️ zone only; needs AI/OCR queue |
| AI Secretary | **NEW** `formDefinitions`, `formSubmissions`, `fieldValues` | **NEW** `secretary.*` | ❌ |
| Field map | `operatingZones`, `locationIdentities`, `facilities`, `routeDecisions` | existing list endpoints | ⚠️ no bridge/axle tables |
| Report a condition | **NEW** `fieldObservations` | **NEW** `observations.create/list/approve` | ❌ |
| Pre-trip | `inspections`, `maintenanceDefects`, `complianceDocuments` | `identity.inspections.*` | ⚠️ no dispatch-block logic |

### Shop (mechanic)

| Screen | Entities | Endpoints | State |
|---|---|---|---|
| Unit passport | `units`, `complianceDocuments`, `inspections`, **NEW** `unitMeters` | `identity.units.*`, `scans.create` | ⚠️ no engine/PTO hours |
| Defects | `maintenanceDefects` | `compliance.maintenance.*` | ⚠️ no severity escalation / release |
| Work orders | `workOrders` | `workOrders.list/create/update` | ✅ (update unwired) |

### Office

| Screen | Entities | Endpoints | State |
|---|---|---|---|
| **Exception centre** | aggregation across 8 tables | **NEW** `exceptions.summary/list` | ❌ |
| **Jobs** | `jobs`, `jobUnits` | `jobs.list/create/byCode` | ⚠️ endpoints exist, zero UI |
| Trips | `trips`, `tripStops`, `manifests` | `trips.*`, `manifests.*` | ⚠️ no package generation |
| Documents & expiry | `complianceDocuments` | `identity.documents.*` | ⚠️ no expiry computation |
| Disposal directory | `facilities` | `compliance.facilities.*` | ⚠️ 5 todo items open |
| Billing | `billingRateCards`, `jobChargeLines` | `billing.*` | ⚠️ no auto-generation from trips |
| **Audit log** | **NEW** `auditLog` | **NEW** `audit.list` | ❌ |
| **Feedback queue** | **NEW** `feedbackItems` | **NEW** `feedback.create/list/triage` | ❌ |

### Admin

| Screen | Entities | Endpoints | State |
|---|---|---|---|
| Operating zones | `operatingZones`, `zoneEvents` | `operatingZones.*` + **NEW** `zones.stats` | ⚠️ no rejection stats |
| Roles & permissions | `users` | **NEW** `admin.roles.*` | ❌ (only `user`/`admin` today) |
| Sync & offline | client-side | **NEW** `sync.push/pull/conflicts` | ❌ |

---

## 3. New tables required

```
auditLog          entityType, entityId, field, oldValue, newValue,
                  reason, actorId, actorRole, occurredAt
                  → never update in place; append only

formDefinitions   key, version, title, fieldsJson, validationJson, active
formSubmissions   formKey, formVersion, tripId?, unitId?, operatorId?,
                  transcript, status, submittedAt, confirmedAt
fieldValues       submissionId, fieldKey, value, precision, source,
                  confidence, status, correctedFrom?

fieldObservations observationType, latitude, longitude, accuracyMetres,
                  roadLabel, direction, unitId, operatorId, severity,
                  photoKey?, voiceKey?, confirmations, status

feedbackItems     screenKey, submittedByRole, problem, frequency,
                  impact, status, resultingChangeRef?

unitMeters        unitId, meterType (odometer|engine|pto|pump|vacuum|idle),
                  reading, recordedAt, source
```

Two notes on shape:

- `auditLog` is **append-only**. The design documents are explicit — "never silently overwrite
  important operational data." An update-in-place audit table defeats its own purpose.
- `fieldValues` is separate from `formSubmissions` because one submission produces many values with
  *different* provenance — the driver may state the time exactly and the quantity approximately.
  Storing provenance per submission would lose that.

---

## 4. Build order

Each phase leaves the app working. No phase depends on a later one.

### Phase 0 — Stabilise (nothing new until this lands)

1. Archive v1; v2 is the only trunk
2. Prettier across all pages — `.prettierrc` exists but is unenforced, and lines currently run to 11,259 characters
3. Fix `TripOperationsWorkspace.tsx(77,846)` — `number | null` into `number | undefined`
4. Split pure tests from DB tests so `pnpm test` is green without a database
5. Resolve `trpc.ai.chat` — the endpoint does not exist

### Phase 1 — One workflow, end to end

6. `jobs` UI: list, create, detail — the root record currently has none
7. Trip creation starts from a job
8. Confirmation screen wired to `gps.pendingZoneEvents` / `confirmZoneEvent`; confirmed events write `arrivedAt` / `departedAt`
9. `auditLog` table + write-through on every correction
10. Wire the remaining `update` mutations so records can be corrected in-app

**Gate:** Job → Trip → GPS proposal → driver confirms → timeline updates → audit row written.
One complete path working beats ten half-built ones.

### Phase 2 — Exception centre & expiry

11. Expiry computation over `complianceDocuments.expiresAt`
12. Exception aggregation query (8 sources, one response)
13. Office dashboard + click-through to each fix
14. `feedbackItems` + the "Make this easier" control on every screen

*(14 is small but must ship before the pilot, not after — otherwise there's nothing to measure.)*

### Phase 3 — AI Secretary

15. `formDefinitions` registry — start with three forms: load stop, unload stop, defect report
16. Extraction on `llm.ts` using `outputSchema` constrained to the active form
17. `fieldValues` with per-field precision/source/confidence
18. Gap detection → minimum clarifying questions
19. Read-back-before-commit (mandatory, not optional)
20. Voice via existing `voiceTranscription.ts` — currently unused
21. Office review dashboard, each value traceable to its source utterance

Build **one engine, not eight secretaries.** Each "secretary" in the design document is a form
definition, not new code.

### Phase 4 — Genuine offline

22. PWA shell — service worker + manifest
23. IndexedDB mirror of trips / stops / breadcrumbs / duty records
24. Outbound queue with retry + visible "saved locally" state
25. Conflict surfacing for human resolution — never auto-merge
26. Pre-departure cache: route, sites, facilities, rate card

### Phase 5 — Mapping depth

27. Vehicle + load routing profile (axle groups, spacing, loaded dimensions)
28. Bridge/clearance table where `unknown` is a distinct state from `clear`
29. Axle-group evaluation against posted limits
30. Municipal rule engine — versioned, effective-dated, jurisdiction-scoped
31. Site baselines from accumulated `tripStops` + `zoneEvents`

### Phase 6 — Deferred layers

Commercial fuel network and two-way radio/CB. Both fully specified in the design documents, both
with zero code presence today, both purely additive. They reuse the `operatingZones` + provenance
patterns the GPS engine already proves.

---

## 5. What the prototype deliberately shows

Worth reviewing these specifically, since they're the decisions hardest to change later:

- **Confirmations as a first-class screen**, not a toast. Automation proposes into a queue.
- **Amber-dashed unconfirmed values on every screen** — a departure time reads as provisional on the
  timeline, the trip card, and the billing hold, from one source of truth.
- **Gaps rendered as gaps** on the timeline. The 1h42m transit shows as an unfilled segment rather
  than being interpolated.
- **`unknown` never renders as `clear`.** The route check shows "NOT ESTABLISHED" for the DG
  corridor rather than a green tick.
- **Rejected proposals are retained.** Five rejections at one zone is a map problem, not five driver
  errors — the zones admin screen surfaces exactly that.
- **Billing lines cite their source event.** That's what makes a wait-time charge defensible when a
  customer disputes it.
- **The blocked-billing message names three specific things**, not "incomplete".

---

## 6. Open questions to settle before Phase 1

1. **Trip numbering** — `TRIP-2026-004821`: per-year reset or continuous? Affects the sequence table.
2. **Can a trip exist without a job?** The prototype says no. If yard moves or deadhead need trips,
   there must be an internal job type.
3. **Who can correct what?** The prototype lets office correct driver values with a reason. Confirm
   drivers may amend their own records post-submission, and for how long.
4. **Zone radius default** — currently 75 m. South Pit's 23% rejection rate in the prototype is the
   argument for making this per-site and tracked.
5. **Pilot baseline** — the six measures on the feedback screen need paper-based baselines captured
   *before* go-live, or the pilot ends with opinions rather than evidence.
