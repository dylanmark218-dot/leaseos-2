# LeaseOS — codebase handoff

*A read-only snapshot of what this repository contains, prepared for external review. Nothing was
implemented, fixed or changed to produce it.*

---

## Current repository

| | |
|---|---|
| Repository | `dylanmark218-dot/leaseos-2` |
| Branch | **`main`** |
| HEAD SHA | **`f21cd1bc2070ae179d431177fd0f286965e0f3c3`** |
| Release | **v23.25** (`LEASEOS_RELEASE`) |
| Audited | 2026-09-21 |
| Tracked files | 1 237 |
| Production source files | **444** (302 server `.ts`, 138 client `.ts`/`.tsx`, 4 shared) |
| Test files | **304** (296 server, 8 client DOM) |
| Tests | **4 199** — 4 196 pass, 3 skipped, on a clean MariaDB |
| Migrations | **165** (`0000`–`0168`) |
| Database tables | **408** |
| API procedures | **690** (245 queries, 445 mutations) across **63 routers** |
| UI routes | **38** |
| Permissions / roles | **337** permissions (125 sensitive), **15** domain roles |

**Stack**: React 18 + Vite 7 + wouter on the client; Node 22 + Express + tRPC v11 on the server;
MariaDB 10.11 via Drizzle ORM. Full detail in `SYSTEM_ARCHITECTURE.md`.

> ### One thing to know before reading further
> **PR #4 (`readiness-defect-repair`) is OPEN and NOT MERGED.** It repairs three confirmed readiness
> defects. Everything in this handoff describes `main`, which still contains them.

---

## The single most important finding

**133 of 690 procedures (19%) can be reached from the LeaseOS application. 557 cannot.**
**48 of 63 routers have zero UI.**

This is not a handful of admin endpoints. It includes the entire dispatch gate, the whole shop and
mechanic-release workflow, hours of service, enforcement, offline sync, telematics, payroll and all
nine finance routers. The server is a large, tested, well-structured system; the application in front
of it reaches about a fifth of it.

Everything else below should be read against that fact.

---

## Fully implemented

Substantial functionality with a real production path end to end.

| Feature | Why it qualifies |
|---|---|
| **Authentication and authorization** | JWT via `jose` with appId binding (`sdk.ts:238`); `assertProductionSecrets` refuses to boot production without a ≥32-byte secret; 337 permissions across 15 roles; **zero bare `protectedProcedure`**, CI-pinned |
| **Audit trail** | Every `roleProcedure` call records a decision *including denials*; 125 sensitive permissions **refuse rather than act unrecorded** |
| **Customer / vendor / facility portals** | The strongest chain in the product — 38 `externalProcedure` calls, 0 `roleProcedure` (CI gate 7b), bearer tokens SHA-256 hashed, MFA, lockout, and 23 of 36 procedures actually called from the portal client |
| **Training Academy** | Requirement bindings matched against job facts, per-requirement enforcement channels, certificates, signatures, assessments, a retention trigger verified on every migration run — **and a working screen** |
| **Field tickets, loads and disposal** | Per-line acceptance, rejected volumes, signatures, chain of custody, portal submission — reachable |
| **Facility directory** | 408-table schema's best-evidenced area: aliases, capabilities, hours, source licences, import runs, ArcGIS importer, two working screens |
| **Manifests / chain of custody** | Unique manifest ID, party snapshots, custody events, amendments, fact reconciliation |
| **P8.1 inter-engine status contract** | `PASS/REVIEW/BLOCKED/UNKNOWN/NOT_EVALUATED`; `NOT_EVALUATED` never rounds to PASS; the degradation suite enumerates capabilities **from source**, so a new capability without a case fails |
| **Communications / radio planning** | A genuinely advanced engine wired into a live decision path |
| **Background workflow worker** | Polled, batched, lifecycle-managed, shipped as its own bundle |
| **Migrations** | A checksummed ledger that refuses on drift |

## Partially implemented

| Feature | What is missing |
|---|---|
| Multi-tenant isolation | Mechanism and 12 test suites exist, but only 4 record types carry ownership and `actingScope.ts` states *"single-tenant in fact"* |
| Hours of service | Registry, promotion ledger and separation of duties exist. **No cycle computation, reset rules, sleeper-berth splitting, ELD ingestion or 160 km logic.** Key values *"STILL CONTESTED in the seed"* |
| P8.2 automation policy | Fully built and snapshotted onto every decision — **but nothing branches on the mode**; `committedProvenance` is called only from its own test |
| P8.3 manual evidence | Built for **HOS only**; the other seven capabilities have no attestation path |
| Offline runtime | Outbox and sync engine complete and tested; **no device runs them** |
| GPS / zone events | Tables and geofence engine exist; `fieldRoute.gps` is 0/5 UI-reachable |
| Compliance documents | Consumed live by readiness — but `needs_review` documents satisfy a credential check |
| Road graph / routing | Engines validated against 508 807 Alberta ways and **all four are declared unwired** |
| Knowledge corpus | Ingestion built; `repository`, `perimeter`, `evaluationState` half-wired |
| Commercial office | Deep and tested; every finance router is 0/N UI-reachable |

## Implemented backend, missing UI

**48 routers, 557 procedures.** In full in `UI_INVENTORY.md`. The ones that matter most:

| Router | Procedures | What cannot be done through the app |
|---|---|---|
| `dispatch` | 8 | **readiness, evaluate, override request/grant, award — the entire dispatch gate** |
| `shop` | 25 | **work orders, mechanic releases**, parts, tires, tools, warranty, recalls |
| `records` | 19 | **maintenance release and revocation**, incidents, near-misses, legal holds, evidence, retention |
| `hos` | 10 | **attestation, scanned logs, limit promotion** |
| `enforcement` | 11 | **roadside stops, out-of-service orders, release policy, inspector panel** |
| `payroll` | 22 | pay runs, banking, tax identifiers |
| `telematics` | 7 | fault acknowledgement, defect creation |
| `sync` | 3 | **offline package receive / push** |
| `automationPolicy` | 6 | P8.2 entitlement, policy, override, history |
| `restrictedVault` | 9 | P8.5 restricted records |
| `insurance`, `asset`, `compliance`, `workforce`, `closeout`, `manifestCustody`, `invoicing`, `ar`, `gst`, `ifta`, `fuel`, `audit`, `agent`, `device`, `integration`, and 27 more | — | — |

## UI existing but backend incomplete

Comparatively rare, because the client is small.

| Surface | State |
|---|---|
| `components/AIChatBox.tsx` | **378 lines, zero network calls.** Mounted only in the component gallery. There is no working AI chat. |
| `pages/HosVerificationConsole.tsx` | 328 lines, **zero API calls** |
| 24 showcase panels | Declare themselves *"demonstration layout"* on screen with a named reason |

**No client call points at a procedure that does not exist.** All 133 resolve.

## External blockers

Full detail in `EXTERNAL_DEPENDENCIES.md`.

| Blocker | Blocks |
|---|---|
| **Forge API endpoint + key** | **all AI**, and the only notification path |
| **No SMS / email / push provider** | every outbound alert channel |
| **Alberta 511 permission** (P2.2 — the only row the register itself marks BLOCKED) | live closures, incidents |
| **AER permission** (P6.8) | ST107 well/facility mirroring |
| **Provincial data licences** | 13 of 21 sources `unverified`; Saskatchewan IRIS unconfirmed (P6.9) |
| **Valhalla / HERE not deployed** | province-wide routing |
| **No Capacitor shell, no plugins, no `android/`, no `ios/`** | encrypted storage, camera, GPS, biometrics, offline field use |
| **LoadSense devices** (P4.2) | volume/weight telemetry |
| **Hosting, `DATABASE_URL`, DNS** | the repository contains **no deployment artifact of any kind** |
| **HOS regulatory verification** (P0.8, P6.1, P6.4, P6.5) | a person must read the clause |
| **P8.4 owner decision** | which capabilities may never run AUTO |
| **Product name** | *"LeaseOS or BighornOS"* is still an open owner decision |

## Known defects — not fixed

| Defect | Status |
|---|---|
| **A critical defect is cleared by ANY later work-order release** — unrelated, failed-test, or **revoked**. Readiness matches releases to defects by timestamp (`readinessComposer.ts:318-330`) | **in main**; confirmed by execution; PR #4 open |
| **A defect can never reach `resolved`** — five inserts, zero updates. `telematicsRouter.ts:51` depends on a state nothing can produce | **in main** |
| **Active out-of-service orders do not block dispatch** — `composeReadiness` reads enforcement only from `subject.enforcement`, which no production caller supplies | **in main**; confirmed by execution |
| `workOrderReleases.resolvedDefectIds` written on every release and **never read** | in main |
| Two `blocking` blockers advertise an override the award gate cannot honour | static finding |
| `needs_review` documents satisfy a credential check | static finding |
| `invoicing.void` mutates in place with no period check; `invoices` has no accounting date | the repo's own audit raised it |
| Two migrations share prefix `0157` | recorded in the roadmap |
| **P6.7** purchase orders have two unreconciled limit sources — suspected dead configuration | flagged, not investigated |

## Security state

**Strong where it is built; several standard controls are simply absent.**

Present and verified: JWT with appId binding; production secret boot guard; RBAC with 337
permissions and zero bare procedures (CI-pinned); audit on every call including denials; sensitive
permissions fail closed on an unrecordable audit; Zod validation on every procedure; a separate
portal gate (bearer + MFA + lockout) and machine gate, both count-pinned in CI; document access
authorizers; device signature attestation; vault fail-closed tests.

**Absent**: rate limiting · CSRF policy (roadmap: *"`SameSite=None` with no explicit CSRF policy"*) ·
CORS configuration · helmet · encryption at rest (device-side, and there is no device) · server-side
JWT revocation (*"one-year JWTs"*) · **SAST, dependency and secret scanning in CI**.
`pnpm audit` reports **110 findings, 2 critical, 39 high**.

## Mobile / offline state

**There is no mobile application.** No `android/`, no `ios/`, no Capacitor dependency, plugins not
installed. `client/src/runtime/adapters/capacitor.ts` is 53 lines in which **every binding throws
`NotOnDeviceError`**, and its header lists the plugins as *"not installed in this repository"*.

The offline runtime it would drive **is** written and tested: a six-state durable outbox that deletes
nothing, and a sync engine that puts out-of-service orders, HOS events and roadside enforcement at
priority tier 0. It runs against an in-memory adapter.

## AI state

| | |
|---|---|
| **Real** | One path: voice transcript + form key → structured **proposal** awaiting human readback (`routers.ts:691`). It never writes a domain record directly. |
| **Blocked** | `_core/llm.ts` is a hand-written OpenAI-shaped HTTP client — **there is no LLM SDK in `package.json`**. It throws without `BUILT_IN_FORGE_API_KEY`. |
| **Planned only** | Multi-agent planner/executor/tester/reviewer; AI action gateway; model routing (`modelGateway` declared unwired: *"no AI provider is configured yet"*). |
| **Mock only** | `AIChatBox.tsx` — zero network calls, component gallery only. `agentRouter` — 5 procedures, no UI, 3 tests skipped as unreachable. |

The governance around AI is real even though the AI is not: proposals, human readback, audit receipts
and a tested agent boundary all exist.

## Mapping state

**Nothing is live.** 21 external sources are declared; **13 are `unverified`**. The feed machinery
(`feedScheduler`, `feedCollector`, `feedIngest`, `feedHttp`, `advisoryImpact`) is complete and
**declared unwired because the scheduler is never started**. The four OSM engines are validated
against Alberta's full extract and **nothing calls them**.

Real and working: the facility directory, route evaluation against stored approvals, and
communications/radio planning. Absent: offline maps, tile caching, satellite imagery, weigh stations,
school/residential avoidance, alternative routes, external navigation handoff, live weather and
closures.

## Compliance / HOS state

**Real**: the *architecture*. Rules are registry values under a promotion ledger with separation of
duties (`limitPromote` refuses the recorder of an unverified candidate), a verification console route,
paper-log and scanned-log attestation that is marked as stated-not-computed, and non-overridable
dispatch blocking on a computed insufficiency.

**Not real**: the *numbers*. `CA_FEDERAL_NORTH60.daily_on_duty_minutes` is **"STILL CONTESTED in the
seed"**; three further rows need a person to read a clause. And **no cycle computation, reset rules,
sleeper-berth splitting, ELD ingestion, exemption handling or 160 km home-terminal logic exists.**

TDG: manifests and chain of custody are strong. **TDG classification itself is not implemented** —
no table for classes, UN numbers, packing groups or placards; `dangerousGoods` is derived by regex
from job type and mode, and `tdgDocumentPrepared` / `emergencyPlanOnFile` are set to UNKNOWN whenever
it is true, with nothing to establish them.

---

## Remaining major product gaps, ranked

*A snapshot for review, not a development plan.*

### Critical

1. **The dispatch gate has no user interface.** The engine that decides whether a truck may legally move cannot be operated from the application.
2. **A critical mechanical defect can be cleared by an unrelated, failed or revoked release**, and no defect can ever be marked resolved. *(PR #4 open.)*
3. **Active government out-of-service orders do not block dispatch.** The data exists, the evaluator is correct, and nothing joins them.
4. **No mobile application exists.** Every field capability — camera evidence, GPS, biometric signing, offline operation — depends on a shell that is not in the repository.
5. **HOS figures are unverified and the cycle engine does not exist.** The architecture is sound; the regulatory content is not established.

### High

6. **557 procedures have no UI** beyond the four above — the shop, records, enforcement, payroll and all nine finance routers.
7. **No notification delivery of any kind.** Warnings are computed and surfaced nowhere.
8. **No contact directory.** No contact table of any kind exists.
9. **No TDG classification.** Classes, UN numbers, packing groups and placards are absent.
10. **HTTP hardening gaps**: no rate limiting, CSRF, CORS or helmet; 110 dependency vulnerabilities with no scanning in CI.
11. **Mapping has no live data path.** Complete machinery, scheduler never started, 13 of 21 sources unverified.

### Medium

12. Tenant isolation covers 4 record types and the system is single-tenant in fact.
13. P8.2's automation mode has no operational consumer; P8.4 is undecided.
14. 38 orphaned tables, 29 write-only, 23 read-only; 52 declared-unwired engines.
15. `needs_review` documents satisfy credential checks.
16. `invoicing.void` can alter a closed accounting period.
17. LoadSense persistence exists with no device ingestion.

### Low

18. Two migrations share prefix `0157`.
19. `drizzle/meta/_journal.json` is vestigial and misleading.
20. P6.7 purchase-order limits — suspected dead configuration.
21. The product name is undecided.

---

## Companion documents

`SYSTEM_ARCHITECTURE.md` · `FEATURE_INVENTORY.md` · `LEASEOS_FEATURE_MATRIX.md` ·
`DATABASE_INVENTORY.md` · `API_INVENTORY.md` · `UI_INVENTORY.md` · `TEST_INVENTORY.md` ·
`EXTERNAL_DEPENDENCIES.md` · `GAPS_AND_DISCONNECTED_CODE.md` · `REGISTER_STATUS.md` ·
`feature-matrix.json` · `REPO_FILE_MANIFEST.txt`

## A note on this repository's own honesty

Three things make this audit unusually reliable, and they are worth knowing about the codebase:

- **`server/engineReachability.test.ts`** maintains a register of **52 engines that exist but are not wired**, each with a stated reason, and fails if an engine is unreached *and* undeclared — or declared *and* actually wired.
- **`client/src/showcase/panelSource.ts`** makes every showcase panel declare on screen whether it is reading records or is a demonstration layout, with the rule *"a query that returns nothing is NOT records."*
- **`docs/P_ROW_SUBSTANCE_AUDIT.md`** is a prior audit that compared each DONE register row against its *original* definition and found three closed without meeting a clause.

This codebase documents its own gaps more rigorously than most document their features. Where this
audit says something is missing, the repository usually says so first.
