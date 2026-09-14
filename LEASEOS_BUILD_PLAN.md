> **HISTORICAL — DO NOT USE AS CURRENT IMPLEMENTATION STATE.** This document describes an earlier plan. The implemented state is in `LEASEOS_CURRENT_STATE.md` (generated) and the per-release checkpoints.

# LeaseOS / FieldRoute — Consolidated Build Plan

**Audit date:** 29 August 2026
**Scope:** all uploaded material — `leaseos-fieldroute.zip` (v1), `leaseos-fieldroute-trip-operations-v2.zip` (v2), and the five design documents in conversation (trip operations ×2 duplicates, commercial fuel network, two-way radio/CB layer, commercial vehicle mapping/routing, AI Secretary).

This document reconciles **what was designed** against **what actually exists in code**, then sequences the remaining work. It is intended to be the single reference that replaces the scattered design notes.

---

## 1. What the uploads actually contain

### 1.1 The two zips are not two projects

`v1` is a strict ancestor of `v2`. A full recursive diff shows v2 differs only by:

- one added page (`TripOperationsWorkspace.tsx`)
- one added migration (`0008_trip_operations.sql`)
- the trip/stop/zone/duty/work-order schema additions
- the corresponding `db.ts` / `routers.ts` / test changes

**Action: archive v1.** Keeping two near-identical trees invites edits landing in the wrong copy. v2 is the only live trunk. (v1 does hold `research_hos_sources.md`, which v2 also carries — nothing is lost.)

### 1.2 Codebase inventory (v2, post-audit)

| Layer | Detail |
|---|---|
| Stack | React + Vite + TypeScript, tRPC, Drizzle ORM on MySQL, Vitest |
| Schema | 34 tables |
| Migrations | 10 (`0000`–`0009`) |
| Backend procedures | 75 defined |
| UI pages | 11 |
| Test files | 3 |

### 1.3 Design documents → coverage

| Design document | Coverage in code |
|---|---|
| Trip operations / single trip record | **Substantial** — trips, tripStops, operatingZones, dutyRecords, workOrders, manifests, billing all persisted |
| Commercial vehicle mapping & routing | **Partial** — routeDecisions + RouteSafetyWorkspace exist; no bridge/axle/clearance/municipal rule tables |
| Commercial fuel network | **Absent** — zero code presence |
| Two-way radio / CB layer | **Absent** — zero code presence |
| AI Secretary | **Scaffolding only** — see §3.1 |

---

## 2. Verified gaps found during this audit

These are not opinions about design; they are things that are demonstrably broken or missing in the uploaded code.

### 2.1 Fixed during this audit

**Missing migration for the GPS engine.** The `tripBreadcrumbs` and `zoneEvents` tables existed in `schema.ts` but had no migration file, so a fresh deploy would have had a schema/DB mismatch and every GPS write would fail at runtime. Added `0009_gps_zone_events.sql` with the tables plus three indexes (`tripId+recordedAt`, `tripId+detectedAt`, `status`) — breadcrumb ingestion queries on those columns on every ping, so the indexes are load-bearing, not cosmetic.

### 2.2 Open — high severity

**`AIChatBox.tsx` calls an endpoint that does not exist.** The component calls `trpc.ai.chat.useMutation`, but there is no `ai` router anywhere in `routers.ts` or `systemRouter.ts`. It is currently only rendered inside `ComponentShowcase.tsx` (a demo page), so it isn't user-visible — but it will fail the moment anyone mounts it. This is the stub where the AI Secretary is supposed to live.

**The `jobs` table has no UI at all.** `jobs.list`, `jobs.create`, and `jobs.byCode` are all defined and none is called anywhere in the client. Every design document treats Job as the root object that Trip hangs off — but in the running app it is unreachable. Trips are currently created without a real job selection flow.

**Pages are effectively unmaintainable.** Source lines run to 11,259 characters:

| Page | Bytes | Longest single line |
|---|---|---|
| BillingSafetyWorkspace.tsx | 14,644 | 11,259 |
| RouteSafetyWorkspace.tsx | 13,381 | 9,673 |
| ComplianceEngine.tsx | 12,824 | 9,665 |
| OfflineVault.tsx | 11,837 | 9,581 |
| Home.tsx | 55,780 | 8,180 |
| DisposalDirectory.tsx | 11,607 | 8,104 |

This is why the one outstanding type error reports as `TripOperationsWorkspace.tsx(77,846)` — column 846. Code at this density cannot be reviewed, diffed, or safely edited by anyone, human or model. It is the single largest risk to the six-month pilot, because pilot velocity depends on making small changes quickly in response to driver feedback.

**Outstanding type error.** `TripOperationsWorkspace.tsx(77,846)`: `Type 'number | null' is not assignable to type 'number | undefined'` — a nullable DB column being passed into an optional-typed prop. Pre-existing, unrelated to the GPS work.

### 2.3 Open — medium severity

**23 of 75 backend procedures have no UI consumer**, including `trips.update`, `tripStops.update`, `workOrders.update`, `vendors.update`, `unitSafety.update`, `billing.rateCards.update`. The pattern is clear: **create and list flows were built, edit flows were not.** In practice this means a driver or office user can enter data but cannot correct it in-app — which directly contradicts the audit-trail/correction principle in the trip operations document ("Office corrected quantity: 8.2 → 8.7, reason: corrected from scale ticket").

**"Offline-first" is currently a label, not an architecture.** There is no service worker, no PWA manifest, no IndexedDB/Dexie/localForage, and no sync queue anywhere in the codebase. `OfflineVault.tsx` calls two ordinary `useQuery` endpoints — it renders offline-*themed* content while requiring a live network connection to do so. Given that the design documents call offline-first "a major requirement," this is the largest gap between stated intent and reality.

**No audit-trail table.** The design document is explicit: "Never silently overwrite important operational data." There is no `auditLog`/`changeLog` table. Amendments to trip quantities, times, and manifests currently overwrite in place with no before/after record.

**No exception-center backend.** The office dashboard concept (missing documents, expiring licences, trips missing tickets, excessive loading times) has no aggregation query behind it. `expiresAt` columns exist on `complianceDocuments`, so the data is there — nothing computes against it.

**Test suite cannot run green in CI.** 13 of 26 tests fail without a `DATABASE_URL`, because the `db.ts` helpers return `undefined` when no DB is configured and the tests assert on defined IDs. The new `geofence.test.ts` (10 tests) passes standalone precisely because it is pure. That is the pattern to extend: push logic into pure modules, test those directly, and reserve DB-dependent tests for an integration job with a real test database.

---

## 3. Architectural decisions to lock in before more building

### 3.1 The AI Secretary should be one engine, not eight

The design document lists eight "secretaries" (Trip, Logbook, Safety, Maintenance, Manifest, Billing, Document). Building eight prompt flows would produce eight things to debug and eight places for behaviour to drift.

Build instead a **single schema-driven conversational form engine**:

```
form definition (fields, types, required, validation)
        │
        ▼
intent classification ── which form does this utterance belong to?
        │
        ▼
schema-constrained extraction ── model fills only declared slots
        │
        ▼
per-field tagging ── { value, precision, source, confidence }
        │
        ▼
gap detection ── ask only the minimum missing questions
        │
        ▼
read-back ── always, before anything compliance/billing-touching
        │
        ▼
commit with provenance
```

Each "secretary" then becomes a form definition, not new code. `server/_core/llm.ts` already supports tool-calling and `outputSchema`, which is exactly the mechanism for constrained extraction — the scaffolding is there, unused.

**Non-negotiable rule, carried from the design docs:** "around eight" must never silently become `08:00:00`. Store `{ value: "08:00", precision: "approximate", source: "driver_voice", confidence: "medium" }` and make the UI show approximate values differently from confirmed ones.

### 3.2 Provenance is one mechanism, used everywhere

Three subsystems have independently invented the same idea:

- `zoneEvents.confidence` + `status: pending|confirmed` (GPS engine)
- `complianceDocuments.confidence` + `verificationStatus`
- `routeContexts.confidence` + `verifiedAt`
- `loadProfiles.classificationStatus` + `confidence`

These should share one vocabulary and one UI treatment. A single `Provenance` type — `{ source, confidence, verifiedAt, verifiedBy, status }` — applied consistently means the "unknown ≠ safe" principle is enforced by the type system rather than by remembering to apply it each time.

### 3.3 Confirmation is the product's core safety property

The GPS engine now models this correctly: a detected geofence crossing lands as `status: "pending"` and never writes to a `tripStop` until a human confirms. **Every future automation must follow this shape** — AI-extracted form values, OCR'd ticket fields, auto-generated billing lines, predicted maintenance intervals. Propose, show evidence and confidence, wait for confirmation, then commit with provenance.

---

## 4. Sequenced plan

### Phase 0 — Stabilise (do before any new features)

| # | Task | Why first |
|---|---|---|
| 0.1 | Archive v1; make v2 the single trunk | Prevents edits landing in a dead tree |
| 0.2 | Reformat all pages via Prettier (`.prettierrc` already present, just unenforced) | Nothing else is reviewable until this is done |
| 0.3 | Fix `TripOperationsWorkspace.tsx(77,846)` null/undefined error | Only blocker to a clean typecheck |
| 0.4 | Split DB-dependent tests from pure tests; make `pnpm test` green without a DB | Restores CI as a safety net |
| 0.5 | Delete or implement `trpc.ai.chat` | Live reference to a nonexistent endpoint |

### Phase 1 — Close the loop on what already exists

| # | Task | Depends on |
|---|---|---|
| 1.1 | Pending zone-event confirmation UI (driver taps confirm/reject; confirmed event writes `arrivedAt`/`departedAt` to the tripStop) | GPS engine ✅ |
| 1.2 | Jobs UI — list, create, select — and make Trip creation start from a Job | jobs endpoints ✅ |
| 1.3 | Wire the 23 orphaned procedures, prioritising the `update` mutations so records can be corrected | — |
| 1.4 | `auditLog` table + write-through on every correction (before/after/reason/actor) | 1.3 |
| 1.5 | Exception-center aggregation query + office dashboard | `expiresAt` data ✅ |

### Phase 2 — AI Secretary

| # | Task |
|---|---|
| 2.1 | `formDefinitions` schema + registry (start with three forms: load stop, unload stop, defect report) |
| 2.2 | Extraction engine on `llm.ts` with `outputSchema` constrained to the active form |
| 2.3 | Per-field `{value, precision, source, confidence}` persistence |
| 2.4 | Gap-detection + minimum-question generation |
| 2.5 | Mandatory read-back-before-submit UI |
| 2.6 | Voice entry via existing `voiceTranscription.ts` (currently unused) |
| 2.7 | Office review dashboard for AI-created records, traceable to source utterance |

### Phase 3 — Genuine offline-first

| # | Task |
|---|---|
| 3.1 | PWA shell — service worker + manifest |
| 3.2 | IndexedDB local store mirroring the trip/stop/breadcrumb/duty tables |
| 3.3 | Outbound mutation queue with retry + visible "✓ saved locally — waiting for connection" state |
| 3.4 | Conflict resolution on reconnect, surfacing conflicts for human review rather than auto-merging |
| 3.5 | Pre-trip cache: assigned route, site profiles, facility data, comms data pulled before departure |

### Phase 4 — Mapping depth

| # | Task |
|---|---|
| 4.1 | Vehicle + load routing profile (axle groups, spacing, loaded dimensions) |
| 4.2 | Bridge/clearance table with `unknown` as a first-class state distinct from `clear` |
| 4.3 | Axle-group weight evaluation against road/bridge limits |
| 4.4 | Municipal rule engine — versioned, effective-dated, jurisdiction-scoped |
| 4.5 | Site baseline statistics from accumulated `tripStops` + `zoneEvents` |
| 4.6 | Route confidence score surfacing stale/missing data, never rendering `unknown` as `clear` |

### Phase 5 — Deferred layers

Commercial fuel network and two-way radio/CB layers are well specified in the design documents but have **zero code presence**. Both are genuinely valuable and both are additive — they don't block anything else. Defer until Phases 0–3 are solid, then implement as new map layers reusing the `operatingZones` + provenance patterns already proven by the GPS engine.

---

## 5. Six-month pilot instrumentation

The design documents propose measuring before/after. That requires the measurement plumbing to exist **before** the pilot starts, not after:

- Driver feedback capture — currently only a UI string in `TripOperationsWorkspace.tsx`, no persistence. Needs a table, a screen-context field, and an office triage queue.
- Interaction timing — time-to-complete per form, per driver, to substantiate "fewer taps than paper."
- Correction rate — how often office amends driver-entered data (requires the `auditLog` from 1.4).
- Missing-document rate — derivable from the exception center (1.5).
- Workflow versioning — so a change can be traced back to the feedback that caused it.

**All five depend on Phase 0–1 work.** Starting the pilot before they land means running it blind and having no evidence at the end.

---

## 6. Summary

The uploaded material is a genuinely coherent product vision with a real codebase behind it — 34 tables and 75 procedures is substantial, and the compliance/provenance thinking (`research_hos_sources.md`, `research_disposal_sources.md`) is unusually disciplined: sourced, dated, with explicit "review required" boundaries rather than invented legal conclusions.

The gap is not vision or breadth. It is that **breadth ran ahead of depth**: many features have a table and a create/list endpoint but no edit path, no UI, or no supporting architecture. Two headline claims — "offline-first" and "AI Secretary" — currently have no implementation behind them at all.

The highest-value next move is not another feature. It is Phase 0 + 1.1 + 1.2: make the code reviewable, restore CI, and connect Job → Trip → confirmed GPS event end to end so one complete workflow genuinely works before broadening again.
