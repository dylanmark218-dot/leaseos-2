# LeaseOS — master build order

**Source of truth**: `audit/leaseos-current-inventory/` at `main` / `f21cd1bc2070ae179d431177fd0f286965e0f3c3` (v23.25).
**Status**: planning document. No production code, migration or test was changed to write it.

---

## Guiding principle

LeaseOS was built **server-first, deliberately**. That is not architectural failure and this document
does not treat it as one. The evidence that it was a choice rather than drift:

- `server/engineReachability.test.ts` maintains **52 engines declared unwired**, each with a written reason, and fails if one is unreached *and* undeclared — or declared *and* actually wired.
- `client/src/showcase/panelSource.ts` makes every showcase panel declare on screen whether it is reading records or is a demonstration layout, under the rule *"a query that returns nothing is NOT records."*
- `docs/REMAINING_BUILD_REGISTER.md` rows state their own residual work inside the row (P0.5 *"still DESIGN ONLY"*, P0.7 *"still to be served"*).

**The next phase consumes the backend that exists.** 690 procedures are mounted, permission-gated and
tested; **133 are reachable from the application**. The work is to close that gap, not to widen it.

## Prioritisation applied

Each phase was ranked on the owner's six criteria, checked against code:
**(1)** backend maturity · **(2)** safety impact · **(3)** capabilities unlocked · **(4)** external
dependencies · **(5)** new backend required · **(6)** deliverable as a complete vertical slice.

## Work-class vocabulary

| Label | Means |
|---|---|
| **UI/WIRING** | The backend exists, is tested and needs no change. The work is screens. |
| **BACKEND** | Server code must be written. |
| **FOUNDATION** | A large new subsystem others depend on. |
| **EXTERNAL** | Blocked on a key, licence, device, person or owner decision. |

And, for what is missing, this document distinguishes:
**frontend wiring** · **missing backend** · **missing regulatory decision** · **missing external
API/data** · **missing hardware** · **owner decision**.

---

# Verdict on the proposed order

The proposed order is **correct as given, with two changes**, both supported by repository evidence.

### Change 1 — Deployment and Security become parallel tracks, not a phase

The owner's brief already asks for this, and the evidence demands it: the repository contains **no
deployment artifact of any kind** — no Dockerfile, compose file, `.env.example`, Terraform, k8s
manifest or runbook. Its own hardening audit records that *"it cannot be determined from this
repository whether a production deployment exists."* Nothing in phases 1–12 can be *operated* until
Track D exists, so it runs alongside from day one rather than waiting.

### Change 2 — Safety/Enforcement (3) should be split, and its first half moved to phase 2½

`enforcement` has two halves with very different readiness:

- **Enforcement capture and OOS lifecycle** — 11 procedures, complete, tested (`enforcementApi.test.ts`, `enforcementLifecycle.test.ts`, `enforcementOutbox.test.ts`), separate proposer and approver on release. Pure UI/WIRING.
- **Enforcement → readiness** — **does not exist as a production path.** `composeReadiness` reads enforcement only from `subject.enforcement`, and **no production caller supplies it** (`readinessComposer.ts:412`; six call sites, none passes it). This is BACKEND, not wiring.

That second half is a **safety defect of the same class as PR #4** — an active government
out-of-service order does not block dispatch — and it should be fixed near PR #4, not five phases
later. Fixing it before the Dispatcher slice also means the readiness panel shows the truth from day
one rather than being corrected later.

**Everything else in the proposed order is confirmed.**

---

# Ordered phases

| # | Phase | Class | Gating dependency |
|---|---|---|---|
| **0** | PR #4 + enforcement→readiness | **BACKEND** | none |
| **1** | **Dispatcher** | **UI/WIRING** | phase 0 for truthful readiness |
| **2** | **Mechanic / Shop** | **UI/WIRING** | **PR #4 merged** |
| **3** | **Safety / Enforcement** | UI/WIRING | phase 0 |
| **4** | **Office / Finance** | UI/WIRING | none |
| **5** | **Client / Consultant enrichment** | UI/WIRING + small BACKEND | none |
| **6** | **Driver Web** | UI/WIRING | phases 1–3 |
| **7** | **HOS computation engine** | **FOUNDATION + BACKEND + EXTERNAL** | phase 6 for a surface |
| **8** | **Native Field Mobile** | **FOUNDATION + EXTERNAL** | phase 6, phase 7 |
| **9** | **Live mapping / routing feeds** | BACKEND + **EXTERNAL** | none technically |
| **10** | **AI Secretary** | BACKEND + **EXTERNAL** | phases 1–6 for context |
| **11** | **Notifications / emergency** | **BACKEND + EXTERNAL** | none technically |
| **12** | **Sensor / hardware integration** | BACKEND + **EXTERNAL (hardware)** | phase 8 |
| **D** | **Deployment / hosting** | **FOUNDATION + EXTERNAL** | *parallel from day one* |
| **S** | **Security hardening** | BACKEND + EXTERNAL | *parallel, gates public launch* |

---

## Phase 0 — PR #4 and enforcement→readiness  ·  **BACKEND**

**Backend status** — PR #4 is written, green on both CI workflows on `c72a55a`, mergeable, and held
only on an operational backlog question. The enforcement join does not exist.
**UI status** — none, and none needed.
**Existing procedures** — none new.
**Database** — PR #4 adds migration `0169` (four nullable columns, one index; rewrites no data).
**Tests** — PR #4 brings 25 DB-backed cases; nine planted mutations each caught.
**Permissions** — `maintenance.record_release` reused; no permission created.
**External blockers** — one: the production backlog count behind `DATABASE_URL`.
**Work required** — merge PR #4; then wire `composeReadiness` to `outOfServiceOrders` through
`enforcementEvents` (which carries the real `unitId`/`trailerId`/`operatorId`; `subjectRef` on the
order is free text and must not be matched on), tenant-scoped via `coreRecordOwnership`.
**Unlocks** — readiness tells the truth. Every later phase depends on that.
**Deployment/security** — none.

> **Class note**: *missing backend*, not wiring. PR #4 is already written; the enforcement join is not.

## Phase 1 — Dispatcher  ·  **UI/WIRING**

**Backend status** — complete. 8 procedures in `dispatchRouter.ts` (173 lines), the composer (645),
the evaluator (594), the award transaction (373) with posting-level `FOR UPDATE`, idempotent replay,
overlap re-check inside the lock, and fingerprint+age validity.
**UI status** — **zero.** No client file calls any `dispatch.*` procedure.
**Database** — `dispatchPostings`, `dispatchEligibilityChecks`, `dispatchOverrides`, `jobUnits`, `resourceBookings`, `dispatchAuditEvents`.
**Tests** — `dispatchGate.test.ts` (11), `_core/dispatchReadiness.test.ts`, `_core/degradationSuite.test.ts` (25), `enforcementReadiness.test.ts`.
**Permissions** — `dispatch.read`, `dispatch.evaluate`, `dispatch.override.request`, `dispatch.override.grant` (sensitive), `dispatch.award` (sensitive), `dispatch.assign`.
**External blockers** — none.
**Work required** — frontend wiring only. Full spec: `DISPATCHER_VERTICAL_SLICE_SPEC.md`.
**Unlocks** — the safety gate becomes operable. **12 procedures become newly user-reachable** (measured: of the 20 the slice touches, 8 are already reachable) — `dispatch.readiness`, `evaluate`, `overrideRequest`, `overrideGrant`, `award`, `enforcementGet`, `whatAmIMissing`, `fieldRoute.jobs.list`, `jobs.byCode`, `identity.inspections.list`, `readiness.forShift`, `readiness.forTime`. The larger number is qualitative: it is the first time the safety gate can be operated at all.
**Depends on** — phase 0 for a truthful readiness panel; buildable in parallel, shippable after.
**Deployment/security** — `dispatch.award` and `dispatch.override.grant` are sensitive: an
unrecordable audit refuses the call. The UI must surface that refusal, not retry it.

## Phase 2 — Mechanic / Shop  ·  **UI/WIRING**

**Backend status** — complete: `shop` (25 procedures — work orders, releases, parts, tires, tools,
warranty, recalls) and `records.maintenance` (release, revoke, and after PR #4 `resolveDefect`).
**UI status** — **zero.** The client calls neither router.
**Database** — `workOrders`, `workOrderReleases`, `maintenanceDefects`, `parts`, `tires`, `serializedTools`, `warrantyClaims`, `recallNotices`.
**Tests** — `fleetShop.test.ts`, `_core/incidentMaintenance.test.ts`, `productionPath.test.ts`, plus PR #4's 25.
**Permissions** — `shop.release`, `maintenance.record_release` (mechanic, shop_lead), `maintenance.revoke_release` (shop_lead, management). **Note**: only global grants confer these — a branch-scoped mechanic is refused.
**External blockers** — none.

> ### ⚠ **HARD GATE — PR #4 must be merged before this slice is designed against production semantics**
> On current `main`, readiness clears a critical defect from **any** later release row — unrelated,
> failed-test, or **revoked**. A mechanic screen built against that would show a defect as cleared
> when it is not. **Do not design around the timestamp behaviour.** After PR #4 the contract is:
> a release is evidence only when it *names* the defect, is not a revocation, did not fail its test,
> and has not been withdrawn — and resolution is a separate explicit act.

**Unlocks** — the post-deploy defect backlog becomes clearable without API access, which is the
open question currently holding PR #4.
**Deployment/security** — `maintenance.record_release` is sensitive and fails closed on audit.

## Phase 3 — Safety / Enforcement  ·  **UI/WIRING**

**Backend status** — complete for capture and lifecycle. `enforcement` (11), `securityIncidents` (9),
`restrictedVault` (9), `records` incident paths.
**UI status** — zero for all three routers.
**Database** — `enforcementEvents`, `enforcementViolations`, `enforcementCitations`, `outOfServiceOrders`, `oosReleaseFindings`, `oosReleasePolicies`, `roadsidePanelGrants`, `incidentMatters`.
**Tests** — `enforcementApi.test.ts`, `enforcementLifecycle.test.ts`, `oosPolicyApi.test.ts`, `_core/restrictedVault.test.ts`, `_core/vaultFailClosed.test.ts`.
**Permissions** — restricted-vault tiers (`INTERNAL`/`CONFIDENTIAL`/`RESTRICTED`/`HIGHLY_RESTRICTED`), `restricted.read` sensitive.
**Work required** — wiring. The readiness half moved to phase 0.
**Known open question — owner decision, not code**: P8.5's decision names *near misses, drug &
alcohol results, internal investigations*. Only internal investigations are tier-gated; near misses
are not gated at all; **drug & alcohol results are not stored anywhere.** The repository's own audit
raised this and refused to guess. It must be decided before this UI is designed.
**Deployment/security** — the most sensitive data surface in the product.

## Phase 4 — Office / Finance  ·  **UI/WIRING**

**Backend status** — extensive and tested: `commercialOffice` (43), `payroll` (22), `invoicing` (7),
`ar` (8), `gst` (5), `ifta` (7), `asset` (10), `fuel` (7), `bank` (3), `period` (3), `funding` (8).
**UI status** — 15 of 43 `commercialOffice` reachable via `pages/CommercialOffice.tsx`; **the other
nine routers are 0/N**.
**Tests** — `periodClose.test.ts` (`assertPeriodOpen` at 12 call sites), `capitalAssets.test.ts`, `contractTerms.test.ts`, `commercialProjects.test.ts`.
**Work required** — wiring, with two things to resolve first:
- **Owner decision — P6.7**: purchase orders have two limit sources (per-entity limit and approval ladder), unreconciled. *Suspected dead configuration.* Out of scope for this document by instruction; must be settled before a PO screen.
- **Known defect**: `invoicing.void` mutates in place with no `assertPeriodOpen`, and `invoices` carries no accounting date — so voiding an invoice finalized in a closed period alters that period. Raised by the repository's own audit as a question, not a verdict.
**Unlocks** — ~90 procedures.

## Phase 5 — Client / Consultant enrichment  ·  **UI/WIRING + small BACKEND**

**Backend status** — the strongest chain in the product. 38 `externalProcedure`, 0 `roleProcedure`
(CI gate 7b), bearer tokens SHA-256 hashed, MFA, lockout. 23 of 36 already called from the portal client.
**Missing (backend)** — live GPS/telemetry in the portal, and **"consultant" is not a distinct
concept**: there is no consultant record and no contact table at all.
**Work required** — wire the remaining 13 portal procedures (**wiring**); decide whether consultant
is a role, an external identity kind, or a contact record (**owner decision**); telemetry surfacing
depends on phase 12 (**missing hardware**).

## Phase 6 — Driver Web  ·  **UI/WIRING**

**Explicitly not Native Field Mobile.** Browser-accessible functionality only.

**Buildable now** — `dispatch.whatAmIMissing` (the operator's own checklist, reads `ctx.user.id` and
nobody else's — universal permission), `surfaces.myDay`, `surfaces.inbox`, `academy.myTraining` /
`ticketPortfolio` / `assessmentOpen` / `assessmentSubmit` (already partly wired), `fieldRoute.dutyRecords`,
`fieldRoute.compliance.maintenance.create` (defect reporting — already wired).
**Not buildable in a browser** — camera capture, GPS, biometric signing, offline persistence,
device sync, notifications. All belong to phase 8.
**Not answerable yet** — *"how many hours do I have, can I take this dispatch, does sleeper berth fix
this."* That is phase 7.

> **A Driver Web slice is real and useful, and it is not the driver product.** It must not be
> presented as one.

## Phase 7 — HOS computation engine  ·  **FOUNDATION + BACKEND + EXTERNAL**

**What exists — the architecture, and it is good.** Rules are registry values under a promotion
ledger with separation of duties (`limitPromote` refuses the recorder of an unverified candidate),
attestation marked stated-not-computed, a verification console route, and non-overridable dispatch
blocking on a computed insufficiency.

**What does not exist — the engine.** No 7-day cycle, no 14-day cycle, no cycle totals, no reset
rules, no sleeper-berth splitting, no ELD ingestion, no exemptions, no 160 km / home-terminal rules,
no daily-return logic. The roadmap's *"HOS still open"* section lists these.

> **Do not present the registry and attestation architecture as a finished HOS engine.** It is the
> scaffolding a cycle engine would hang from, and the cycle engine is not written.

**Missing regulatory decision** — P0.8 / P6.5 record `CA_FEDERAL_NORTH60.daily_on_duty_minutes` as
**"STILL CONTESTED in the seed"**; P6.1 and P6.4 each need a qualified person to read a clause.
**Owner/legal** — short-haul, HazMat and cross-border assumptions must be checked against regulators.
**Prerequisite for** — the finished driver product. Phase 8 without phase 7 ships a field app that
cannot answer the question drivers actually ask.

## Phase 8 — Native Field Mobile  ·  **FOUNDATION + EXTERNAL**

**What exists** — the offline runtime, written and tested: a six-state durable outbox that deletes
nothing (`outbox.ts`, 99 lines) and a sync engine that puts `oos_order`, `hos_event` and
`roadside_enforcement` at priority tier 0 (`syncEngine.ts`, 215 lines).
**What does not exist** — the shell. `adapters/capacitor.ts` is 53 lines in which **every binding
throws `NotOnDeviceError`**; no `android/`, no `ios/`, Capacitor is not a dependency, and its own
header lists the plugins as *"not installed in this repository."*

**Required (missing hardware / platform)**: native shell · secure local storage (SQLCipher) ·
camera · GPS · biometrics · offline persistence · device sync · push notifications · device identity ·
signing identity · Play Store / App Store enrolment.

**What the header says must be true on the device and cannot be proven here**: the SQLite file is
encrypted at rest with a key from the keystore; the device key is hardware-backed where the platform
offers it and reports `keystoreAttestation: "hardware"` only when it is; biometrics never leave the
platform authenticator.

**Depends on** — phase 6 (a driver surface to wrap) and phase 7 (something worth carrying).

## Phase 9 — Live mapping / routing feeds  ·  **BACKEND + EXTERNAL**

**What exists** — a large, validated, disconnected system. The four OSM engines are validated
against Alberta's 508 807 routable ways and **all four are declared unwired**; the feed machinery
(`feedScheduler`, `feedCollector`, `feedIngest`, `feedHttp`, `advisoryImpact`, `truckRoutingAdapter`)
is complete and declared unwired because **the scheduler is never started from any entry point**.
**Missing external API/data** — Alberta 511 written permission (**P2.2, the only register row marked
BLOCKED**; P6.3 OPEN) · AER ST107 permission (P6.8) · Saskatchewan IRIS licence (P6.9) · **13 of 21
sources `status: "unverified"`** · Valhalla/HERE not deployed.
**Missing backend** — start the scheduler; wire the OSM engines to a graph build.
**Genuinely not implemented** — offline maps, tile caching, satellite imagery, weigh stations,
school/residential avoidance, alternative routes, external navigation handoff.

## Phase 10 — AI Secretary  ·  **BACKEND + EXTERNAL**

**Real today** — one path: voice transcript + form key → structured **proposal** awaiting human
readback (`routers.ts:691`). It never writes a domain record directly. That is a good safety pattern
and it should be the shape of everything added here.
**Missing external API** — `BUILT_IN_FORGE_API_URL` / `BUILT_IN_FORGE_API_KEY`. `_core/llm.ts` is a
hand-written OpenAI-shaped client; **`package.json` contains no LLM SDK at all**.
**Missing backend** — conversational surface, tool calling, document reasoning, route/safety/billing
assistance, multi-agent architecture. `modelGateway` is declared unwired: *"no AI provider is
configured yet."*
**Mock today** — `AIChatBox.tsx`, 378 lines with **zero network calls**, mounted only in the
component gallery.
**Depends on** — phases 1–6, because an assistant with no operational surface to act on has nothing
to assist with.

## Phase 11 — Notifications / emergency communications  ·  **BACKEND + EXTERNAL**

**What exists** — warnings are computed (`surfaces.exceptions`) and `workflowNotifications` rows are
written by the worker. **Nothing delivers them.**
**Missing external** — no SMS, email or push provider dependency of any kind; `notifyOwner` throws
without the Forge endpoint.
**Missing backend** — a delivery abstraction, per-user preferences, an outbox with retry, and
**emergency/SOS, which does not exist at all** — no table, module or procedure.
**Owner decision** — which events warrant which channel; emergency escalation policy.

## Phase 12 — Sensor / hardware integration  ·  **BACKEND + EXTERNAL (hardware)**

**What exists** — `faultCodes` and `_core/telematics.ts` are consumed live by readiness
(`readinessComposer.ts:365-372`); LoadSense persistence exists (7 tables).
**Missing hardware** — LoadSense devices (**P4.2**); CAN/J1939 ingestion; temperature, pressure,
tank level, ABS/brake, refrigeration telemetry.
**Evidence of the gap** — `loadSenseMaterialMovement` and `loadSenseEvents` are declared unwired,
*"device ingestion does not emit it yet"*; `loadSenseScaleReconciliations` and
`materialDensityProfiles` have **no production reference at all**.
**Depends on** — phase 8 for device identity and sync.

---

# Track D — Deployment / hosting  ·  *parallel from day one*

**Nothing in this track exists in the repository.** No Dockerfile, compose file, `.env.example`,
platform manifest, Terraform, Kubernetes manifest or deployment document. `.github/` holds only
`ci.yml` and a PR template. **The hosting provider is not named here and must not be invented.**

| Item | Current state | Needed |
|---|---|---|
| Hosting architecture | **absent** | owner decision: provider, region, topology |
| Container strategy | **absent** | the build already emits `dist/index.js` + `dist/worker.js`; a container is appropriate but not mandatory |
| Environment contract | **partial** | 16 variables are read. Documented nowhere. `assertProductionSecrets` enforces `JWT_SECRET` (≥32 bytes) and `VITE_APP_ID`. Needs an `.env.example` and a startup contract document |
| Production MariaDB | **absent** | **10.11 specifically** — `0021` uses the MariaDB-only `PERSISTENT` keyword and MySQL 8.0 rejects it |
| Migration execution | **exists** | `scripts/migrate.ts` + a checksummed ledger with drift refusal. Needs a deploy step and a `baseline --yes` decision for any pre-existing database |
| Backups / restore | **absent** | roadmap: *"no deploy, backup or restore runbooks"* |
| Domain / DNS / TLS | **absent** | `ssl` appears nowhere in the codebase |
| Logging | **thin** | `console.*` only |
| Monitoring | **absent** | `heartbeat.ts` exists and is declared unwired: *"no monitor calls it"*. Health endpoint always returns `ok: true` |
| Secret management | **external** | `JWT_SECRET`, `DATABASE_URL`, `OAUTH_SERVER_URL`, `LEASEOS_PORTAL_MFA_KEY`, Forge keys |
| Rollback / release | **absent** | note: migration `0169` is additive, so a code rollback needs no down-migration |
| Staging | **absent** | CI builds a throwaway database per run; there is no persistent staging |
| Production smoke tests | **absent** | the gate proves a clean-database build, *not* a running deployment |
| Worker process | **exists, unmanaged** | `dist/worker.js` needs its own supervised process |

**Why parallel**: every phase above is unusable in production until this exists, and it blocks
nothing technically. Starting it late is the single largest schedule risk in this plan.

---

# Track S — Security hardening  ·  *parallel, gates public launch*

> **The existing RBAC and audit architecture is not to be weakened by any item in this track.**
> 337 permissions · 15 roles · 125 sensitive permissions that refuse rather than act unrecorded ·
> **zero bare `protectedProcedure`, CI-pinned** · separate portal and machine gates, both count-pinned ·
> tenant scope helpers that return NOT_FOUND rather than FORBIDDEN. That architecture is the
> strongest thing in the codebase. Hardening is **additive**.

| Control | Current | Work |
|---|---|---|
| Rate limiting | **absent** | per-IP and per-session, with the portal and machine gates rated separately |
| CSRF policy | **absent** | roadmap: *"`SameSite=None` with no explicit CSRF policy"*. Decide double-submit vs origin checking; `SameSite=None` is the reason it cannot be skipped |
| CORS | **absent** | explicit allowlist |
| Security headers / Helmet | **absent** | CSP, HSTS, frame options |
| JWT lifetime / revocation | **weak** | roadmap: *"one-year JWTs with no server-side revocation."* Needs a decision on shortened lifetime + refresh, or a revocation list. **Owner decision** |
| Dependency scanning | **absent** | no scanning in CI |
| Secret scanning | **absent** | no scanning in CI |
| SAST | **absent** | no scanning in CI |
| Vulnerability remediation | **110 findings — 2 critical, 39 high** | triage and remediate; the lockfile is untouched by recent work |
| Production security monitoring | **absent** | depends on Track D logging |

**Additional item the audit found**: uploads trust the client's MIME type (roadmap).

**Gate**: none of phases 1–6 requires Track S to be *built*, but **no public production launch should
precede it**, and the 2 critical dependency findings should be triaged before anything is exposed.

---

# One-line summary

**Phase 0 makes readiness truthful. Phases 1–6 turn 690 procedures into a product without writing
meaningful new backend. Phases 7–12 are the genuinely new systems. Tracks D and S run alongside from
day one, and Track D is the schedule risk nobody is currently carrying.**
