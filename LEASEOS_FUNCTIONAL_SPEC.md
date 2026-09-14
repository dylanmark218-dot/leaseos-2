# LeaseOS / FieldRoute — Functional Specification & Data Contracts

**Purpose:** define the complete feature surface and the data contract behind every screen, so backends are built **once** against a settled interface rather than rebuilt each time the UI moves.

**How to use this with the prototype:** every screen in `leaseos-prototype.html` has a **Data contract** drawer showing the exact endpoints and fields that screen requires. Click through the prototype, mark screens as approved, and the contracts below become the backend work queue. Change the UI *now*, while it costs nothing.

**Status legend:** ✅ built · ◐ partial · ○ not started

---

## Module map — complete surface

| # | Module | Features | Status |
|---|---|---|---|
| 01 | Dispatch | Job board, dispatch readiness check, assignment, driver/unit matching | ◐ |
| 02 | Trip | One-tap driver flow, trip timeline, stops, delay reasons, GPS confirmation, duty log | ◐ |
| 03 | Secretary | Voice interview, form engine, gap detection, read-back, OCR extraction | ○ |
| 04 | Fleet | Unit passport, inspections, defects, work orders, hours tracking, PM prediction, utilization | ◐ |
| 05 | People | Operators, qualifications, document expiry, permissions | ◐ |
| 06 | Documents | Evidence, manifests, safety binder, audit trail, tailgates, proof-of-service, retention | ◐ |
| 07 | Map | Vehicle/load profile, axle routing, bridges, DG routing, municipal rules, lease access, site intelligence | ◐ |
| 08 | Networks | Fuel, water, disposal, scales/washout, radio/CB, cellular/satellite coverage | ◐ |
| 09 | Billing | Rate cards, auto-generated lines, invoicing, vendors, customer package | ◐ |
| 10 | Operations | Exception center, feedback loops, missing-info loop, pilot metrics | ○ |

---

## Cross-cutting contracts

These apply to **every** module. Define once, reuse everywhere — this is the main lever for building backends in an organized fashion rather than repeating the same shapes with different field names.

### Provenance envelope

Every field that can be automated wraps in this. Four subsystems currently invent their own version of it; unify them.

```ts
type Provenance = {
  source: "driver_stated" | "driver_confirmed" | "gps_detected"
        | "ai_extracted" | "ocr_extracted" | "imported"
        | "calculated" | "office_corrected";
  precision: "exact" | "approximate";
  confidence: "low" | "medium" | "high";
  verifiedAt?: Date;
  verifiedBy?: number;
};

type Tracked<T> = { value: T; provenance: Provenance };
```

**Rule:** `unknown` is never rendered as `clear`, `safe`, or `verified`. A missing value and a verified-negative value are different states and must look different on screen.

### Confirmation gate

Any machine-derived value follows the same lifecycle. The GPS engine already implements this correctly; everything else copies it.

```
detect → propose (status: pending) → show evidence + confidence
       → human confirms or rejects → commit with provenance
```

Nothing writes to an operational record on its own authority. `status: pending | confirmed | rejected | expired`.

### Audit envelope

```ts
type AuditEntry = {
  entityType: string; entityId: number; field: string;
  previousValue: string | null; newValue: string;
  reason?: string; actorId: number; actorRole: string; changedAt: Date;
};
```

**Rule:** no operational field is ever overwritten silently. Correction requires a reason.

### Sync envelope

```ts
type SyncState = {
  localId: string;            // client-generated, survives offline
  serverId?: number;
  syncStatus: "local_only" | "queued" | "syncing" | "synced" | "conflict";
  queuedAt?: Date; lastAttemptAt?: Date; attemptCount: number;
};
```

**Rule:** the driver always sees which of their work has left the truck. "✓ Saved locally — waiting for connection" is a required state, not an error state.

---

## 01 · Dispatch

### 1.1 Job board
Existing `jobs` table, currently with **no UI at all** — this is the first gap to close.

**Contract**
```
jobs.list({ status?, dateFrom?, dateTo? })  ✅ exists, unused
jobs.create(jobInput)                        ✅ exists, unused
jobs.byCode({ jobCode })                     ✅ exists, unused
jobs.update({ id, ...fields })               ○ MISSING — no edit path
```

### 1.2 Dispatch readiness check
Composite query answering "can this unit go?" — reads across unit docs, driver quals, open defects, and required trip paperwork.

**Contract**
```
dispatch.readiness({ unitId, operatorId, jobId })  ○ NEW
→ {
    unit:     { insurance, registration, inspection, maintenance, documents }[]
    operator: { license, qualifications, training, hos }[]
    trip:     { job, loadingLocation, unloadingLocation, paperwork }[]
    verdict:  "ready" | "review_required" | "blocked"
    blockers: { area, reason, severity }[]
  }
```
Each check returns `pass | fail | unknown`. **Any `unknown` forces `review_required`** — never `ready`.

---

## 02 · Trip

### 2.1 One-tap driver flow
The primary driver screen. Six buttons per stop, everything else derived.

`ARRIVED → START SETUP → START LOADING → LOADED → DEPART` (and the unload mirror)

**Contract**
```
trips.list / create / update                 ✅ (update has no UI)
tripStops.list / create / update             ✅ (update has no UI)
tripStops.recordEvent({ stopId, event, at, delayReason? })  ○ NEW
```
Each tap writes one timestamp plus a `Provenance` of `driver_confirmed / exact / high`. Durations are **derived, never entered**.

### 2.2 Trip timeline — signature view
The 24-hour duty grid every commercial driver already reads, carrying duty status, trip events, and GPS confidence on one strip.

**Derived fields** (compute server-side, do not store): drive time, loading setup, loading time, loading wait, unloading setup, unloading time, unloading wait, total job time, mileage, idle time, productive time.

### 2.3 Delay reasons
Not just *that* a driver waited — *why*. This is the dataset that becomes negotiating leverage with facilities.

**Enum:** `queue · site_unavailable · customer_delay · disposal_delay · loading_equipment · scale_delay · paperwork · mechanical · weather · traffic · driver_caused · unknown · other`

### 2.4 GPS breadcrumbs & zone confirmation ✅ **built**
```
gps.submitBreadcrumb    ✅   gps.pendingZoneEvents  ✅
gps.breadcrumbs         ✅   gps.confirmZoneEvent   ✅
gps.zoneEvents          ✅
```
Backend complete and tested (10 unit tests). **UI not built** — this is the highest-value next screen.

### 2.5 Duty / HOS log
```
dutyRecords.list / create        ✅
dutyRecords.update               ○ MISSING — amendments impossible
hos.evaluate({ operatorId, at }) ○ NEW
```
HOS evaluation returns `compliant | approaching_limit | exceeded | review_required`, with **`review_required` on any unknown input or jurisdiction crossing**. Sourced against Transport Canada and FMCSA per `research_hos_sources.md`. The app surfaces the calculation and its inputs; it never asserts legal compliance.

---

## 03 · Secretary

**Build one engine, not eight secretaries.** Each "secretary" is a form definition, not new code.

### 3.1 Form definition registry
```ts
type FormDefinition = {
  id: string; name: string;
  fields: {
    key: string; label: string;
    type: "text"|"number"|"time"|"duration"|"enum"|"boolean"|"photo";
    required: boolean; enumValues?: string[];
    validation?: { min?: number; max?: number; pattern?: string };
    dependsOn?: { field: string; equals: unknown };
  }[];
  readBackTemplate: string;
};
```
Start with three: **load stop · unload stop · defect report.** Add the rest as data.

### 3.2 Extraction pipeline
```
secretary.classify({ utterance })        ○ NEW → { formId, confidence }
secretary.extract({ formId, utterance }) ○ NEW → Tracked<T> per field
secretary.gaps({ formId, draft })        ○ NEW → next questions (minimum set)
secretary.readBack({ formId, draft })    ○ NEW → confirmation script
secretary.commit({ formId, draft })      ○ NEW → writes with provenance
```
Uses `llm.ts` `outputSchema` constrained to the active form. **The model fills declared slots only** — it never invents fields.

### 3.3 The precision rule
> Driver: "I was there around eight."

Never `08:00:00`. Store `{ value: "08:00", precision: "approximate", source: "driver_voice", confidence: "medium" }`, then ask: *"Was that 8:00, or approximately 8:00?"* Approximate values render visually distinct from confirmed ones throughout the app.

### 3.4 Read-back before submit — mandatory
No compliance- or billing-touching record commits without the driver hearing it back and confirming.

### 3.5 OCR ticket extraction
```
secretary.extractDocument({ storageKey, expectedType }) ○ NEW
→ Tracked<{ ticketNumber, facility, date, gross, tare, net, unNumber }>
   + suggestedTripId
```
Proposes an attachment; the driver taps to confirm. Never auto-attaches.

**Note:** `AIChatBox.tsx` currently calls `trpc.ai.chat`, which **does not exist**. Delete it or make it the entry point to this engine.

---

## 04 · Fleet

| Feature | Contract | Status |
|---|---|---|
| Unit passport (QR/NFC) | `identity.units.*`, `scans.*` | ✅ |
| Pre/post-trip inspections | `identity.inspections.*` | ✅ list unused |
| Defect capture + severity L1–L4 | `compliance.maintenance.*` | ◐ severity enum needs 4 levels |
| Work orders | `workOrders.*` | ✅ update unused |
| Mechanic release gate | `fleet.release({ unitId, workOrderId })` | ○ NEW |
| Critical-defect dispatch block | folds into `dispatch.readiness` | ○ NEW |
| Engine / PTO / pump / idle hours | `units.hours` columns | ○ MISSING |
| PM prediction | `fleet.serviceForecast({ unitId })` | ○ NEW |
| Utilization dashboard | `fleet.utilization({ from, to })` | ○ NEW |

**Hours tracking matters here specifically:** a vac truck can have low mileage and enormous PTO/pump utilization. Mileage-only maintenance intervals will miss it.

---

## 05 · People

| Feature | Contract | Status |
|---|---|---|
| Operator profiles | `identity.operators.list` ✅ / `create` unused | ◐ |
| Document wallet | `identity.documents.*` | ✅ |
| **Expiry engine** | `people.expiryScan()` → current / expiring / expired / missing | ○ NEW |
| Role permissions | driver · dispatcher · mechanic · office · manager · admin | ○ only user/admin exists |

`expiresAt` columns already exist on `complianceDocuments` — **the data is there, nothing computes against it.** The expiry engine is a query, not a schema change.

---

## 06 · Documents

| Feature | Status |
|---|---|
| Evidence capture, manifests, compliance artifacts, tailgates, transfers, retention/legal hold | ✅ substantial |
| **Audit trail** | ○ **MISSING — no table** |
| Safety binder completeness score | ○ NEW: `documents.binderScore({ unitId })` → `{ percent, missing[] }` |
| Proof-of-service package | ○ NEW: `documents.customerPackage({ tripId })` → PDF |
| Missing-info loop (office → driver → resolved) | ○ NEW |

---

## 07 · Map

| Layer | Contract | Status |
|---|---|---|
| Vehicle + load routing profile | `units` has weight/axles/dimensions as loose strings | ◐ needs structured axle groups |
| Axle-group evaluation | `routing.evaluateAxles({ unitId, loadId, roadId })` | ○ NEW |
| Bridge / clearance table | `bridges` table with `unknown` as first-class state | ○ NEW |
| DG routing | `loadProfiles` ✅ + municipal DG corridors ○ | ◐ |
| Municipal rule engine (versioned, effective-dated) | `jurisdictionRules` | ○ NEW |
| Time-based restrictions / school zones | | ○ NEW |
| Lease access, gates, turnarounds | `locationIdentities` ✅ | ◐ |
| Site intelligence (learned averages) | `map.siteProfile({ locationId })` from `tripStops` + `zoneEvents` | ○ NEW |
| Route risk + **confidence** score | `routeDecisions` ✅ | ◐ |
| Permit-aware routing | | ○ NEW |
| Driver hazard reporting | | ○ NEW |

**Product boundary, carried from the design docs:** the map gives a *routing recommendation*. Permits, signage, and the issuing authority remain authoritative. The UI must never imply legal authorization.

---

## 08 · Networks

All four sub-layers share one shape — **build one `serviceLocations` table with a `layerType` discriminator**, not four parallel tables.

```ts
type ServiceLocation = {
  id: number;
  layerType: "fuel" | "water" | "disposal" | "scale" | "washout" | "repair" | "parking";
  name: string; brand?: string; lat: number; lng: number;
  access: { truckEntrance, truckExit, maxVehicleLength, turningRadius,
            overheadClearance, canExitWithoutBacking, stagingSpace };
  services: string[];
  cardlockNetworks?: string[];   // fuel only
  status: "verified" | "reported_issue" | "closed" | "unknown";
  provenance: Provenance;
};
```

**Accessibility verdict per vehicle** — the point of the whole layer:
`🟢 heavy-truck friendly · 🟡 accessible with caution · 🔴 not recommended for combination vehicles`

### Radio / CB — separate from cellular
```ts
type CommsSegment = {
  roadId: number; fromKm: number; toKm: number;
  system: "cb" | "vhf" | "company" | "repeater";
  channel?: string;                  // never invented — company/site supplied only
  coverage: "good" | "intermittent" | "dead" | "unknown";
  provenance: Provenance;
};
```
Four independent coverage layers: **cellular · two-way radio · satellite · CB.** A road can have no cell and excellent VHF. Route-level `commsReadiness` warns on gaps before a lone driver heads down an isolated lease road.

**Rule:** LeaseOS never invents a channel or frequency. Sensitive repeater details are permission-gated.

---

## 09 · Billing

```
billing.rateCards.*     ✅ (update unused)
billing.lines.*         ✅ (list unused)
billing.autoGenerate({ tripId })  ○ NEW
billing.invoicePackage({ tripId }) ○ NEW
```
`autoGenerate` reads **verified** trip distance, billable time, delay time, and disposal tickets against the approved rate card — then **proposes** lines for office confirmation. Same confirmation gate as everything else.

---

## 10 · Operations

| Feature | Contract | Status |
|---|---|---|
| **Exception center** | `operations.exceptions()` → grouped, actionable, click-to-resolve | ○ NEW |
| Driver feedback ("Make this easier") | `feedback.create({ screen, message, category })` | ○ UI string only, no persistence |
| Office feedback | same table, different category | ○ NEW |
| Missing-info loop | `operations.requestDocument({ tripId, docType })` | ○ NEW |
| Pilot metrics | see below | ○ NEW |

### Exception center query
One dashboard replacing office staff hunting across screens:
```
missing documents · expiring licences · trips missing tickets · units due inspection
excessive loading times · unconfirmed GPS events · incomplete logbooks · expiring insurance
```

### Pilot instrumentation — must exist *before* the pilot starts
- form completion time per driver
- correction rate (needs the audit trail)
- missing-document rate (needs the exception center)
- driver feedback volume by screen
- workflow version tags, so a change traces to the feedback that caused it

Starting the pilot without these means running it blind and having no evidence at the end.

---

## Backend build order

Sequenced so each phase produces something usable and nothing gets rebuilt later.

**Phase 0 — Stabilise.** Archive v1 · Prettier all pages (11k-character lines currently block review) · fix the `TripOperationsWorkspace.tsx(77,846)` type error · split DB tests from pure tests so CI runs green · resolve the dead `trpc.ai.chat` reference.

**Phase 1 — Foundations.** These are dependencies for everything after, so they come before features:
1. `Provenance` type + migration applying it to the four subsystems that already improvised it
2. `auditLog` table + write-through on every correction
3. Role/permission system (6 roles)
4. The 23 orphaned procedures, **`update` mutations first** — users can currently enter data but not correct it

**Phase 2 — Close the loop.** Jobs UI · zone-event confirmation UI · dispatch readiness · exception center · expiry engine.

**Phase 3 — Secretary.** Form registry · extraction · gaps · read-back · voice · OCR.

**Phase 4 — Offline-first.** PWA shell · IndexedDB mirror · mutation queue · conflict resolution · pre-trip cache. *(Currently a label with no implementation behind it.)*

**Phase 5 — Map depth.** Axle groups · bridges · municipal rules · site intelligence · route confidence.

**Phase 6 — Networks.** One `serviceLocations` table · fuel · water · disposal · comms layers.

**Phase 7 — Billing automation & customer package.**

---

## Working method

1. **Click the prototype.** Every screen, both cab and office mode.
2. **Mark screens approved or changed.** Changing a screen now costs nothing; changing it after its backend ships costs a rebuild.
3. **Approved screen → its data contract is frozen.**
4. **Build backends in the phase order above**, against frozen contracts.
5. **UI code is written last**, against a settled backend, so it is written once.
