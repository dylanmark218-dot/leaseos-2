# LeaseOS — system architecture, as the code stands

**Branch** `main` · **HEAD** `f21cd1bc2070ae179d431177fd0f286965e0f3c3` · **Release** `v23.25` (`LEASEOS_RELEASE`)
**Audited** 2026-09-21. Read-only: no production code, migration, test or configuration was changed.

> **PR #4 (`readiness-defect-repair`) is OPEN and NOT MERGED.** Everything below describes `main` as
> it is. The mechanic-release/enforcement repair described in that PR is **not** in this snapshot.

Anything not present is marked **NOT IMPLEMENTED**. Nothing is inferred from documentation.

---

## Stack

| Layer | What it is | Evidence |
|---|---|---|
| Frontend | React 18 + Vite 7 + TypeScript, `wouter` for routing, TanStack Query via tRPC React, Tailwind + Radix UI (`components/ui`) | `client/src/App.tsx`, `package.json` |
| Backend | Node 22 + Express, tRPC v11 | `server/_core/index.ts:54` mounts `/api/trpc` |
| Database | **MariaDB 10.11** (not MySQL — `0021_active_role_uniqueness.sql` uses the MariaDB-only `PERSISTENT` keyword) | `.github/workflows/ci.yml` |
| ORM | Drizzle ORM 0.45 (`mysql2` driver) | `drizzle/schema.ts`, `server/db.ts:90` |
| API architecture | Single tRPC `appRouter` composed of 63 sub-routers; **690 procedures** (245 queries, 445 mutations) | `server/routers.ts` |
| Build | Vite for the client, esbuild for two server bundles (`dist/index.js`, `dist/worker.js`) | `package.json` `build` script |

## Authentication

OAuth-issued session, verified as a **JWT via `jose`**, carried in a cookie.

- `server/_core/sdk.ts` — `authenticateRequest` → `verifySession`.
- **appId binding is present in main**: `sdk.ts:238` rejects a session minted for a different `VITE_APP_ID`.
- **Production secret validation is present in main**: `assertProductionSecrets` (`env.ts:55`) is called at boot (`index.ts:43`) and refuses to start without `JWT_SECRET` (≥32 bytes) and `VITE_APP_ID`.
- **NOT IMPLEMENTED**: `helmet`, explicit CORS policy, CSRF tokens, rate limiting. No match for any of them in `server/_core/index.ts`.

## Authorization — three gates, no fourth

| Gate | For | Where |
|---|---|---|
| `roleProcedure` | staff, by domain permission | `server/_core/trpc.ts:71` |
| `externalProcedure` | customer/vendor/facility portals, bearer token + MFA | `trpc.ts:141`, 38 uses in `portalRouter.ts` |
| `integrationProcedure` | machine clients | 4 uses in `integrationRouter.ts` |

**Bare `protectedProcedure` count: 0** — enforced by CI gate 5.

- **15 domain roles**, **337 permissions**, **125 of them "sensitive"** (an unrecordable authorization decision *refuses* rather than acting unrecorded — `trpc.ts:112`), 13 universal self-scoped.
- **490 of 690 procedures map to a declared permission**; 200 do not (these are portal/integration/public/system procedures under their own gates — see `API_INVENTORY.md`).
- **Branch-scoped grants do not confer permission** unless the procedure resolves a resource branch: `authorize()` (`recordsAuthorization.ts:2009-2016`) drops `scopeRef != null` grants when `resourceBranch` is undefined, which is how `roleProcedure` always calls it. Verified by execution.

## Tenant / company isolation

There is **no tenant column on most tables**. Ownership is a side table.

- `coreRecordOwnership(orgRef, recordType ∈ {unit, operator, load, financial_entity}, recordId)`.
- `ownershipScopeWhere()` (`server/db.ts:791`) builds a correlated subquery; a record with **no ownership row is the single tenant**.
- `resolveActingScope()` (`server/_core/actingScope.ts`) resolves the caller's org from `organizationMemberships`; a user with memberships in more than one org is **refused**, never resolved. `SINGLE_TENANT_ID = "default"`.
- The file states plainly: *"this system is single-tenant in fact"* — multi-tenancy is modelled but the deployment operates as one tenant.

## Audit system

Every `roleProcedure` call — **including denials** — writes an authorization decision row before the handler runs (`trpc.ts:91`). For a sensitive permission, a failed audit write aborts the call.

Domain-level audit also exists per area: `dispatchAuditEvents`, `dispatchOverrides`, `signatureAudits`, `evidenceAccessEvents`, `scanAudits`, `auditPackages`/`auditPackageItems`/`auditPackageAccess`.

## Migrations

- **165 `.sql` files**, `0000` … `0168`, applied in filename order.
- Production runner is a **checksummed ledger**: `scripts/migrate.ts` + `server/_core/migrationLedger.ts` (table `schemaMigrations`), with `status` / `up` / `baseline` and **drift refusal** if an applied file is later edited.
- `drizzle/meta/_journal.json` is **vestigial** — 17 entries, last `0018`. drizzle-kit is not the production mechanism.
- `scripts/apply-migrations.sh` replays every file and is for an **empty** database only (no migration uses `IF NOT EXISTS`).
- **Known**: two migrations share prefix `0157`.

## Offline architecture

Client-side only, and **not running on any device**.

- `client/src/runtime/` — `outbox.ts` (99 lines, six states, nothing deleted; only synchronized items are evictable), `syncEngine.ts` (215 lines, priority ordering — `oos_order`, `hos_event`, `roadside_enforcement` at tier 0), `commsVault.ts`, `crypto.ts`, `safetyLatch.ts`, `contracts.ts`.
- Two adapters: `memory.ts` (used by tests) and `capacitor.ts`.
- **`capacitor.ts` is 53 lines and every binding throws `NotOnDeviceError`** (5 occurrences). Its own header lists the plugins as *"not installed in this repository"*.

## Storage / documents

- `complianceDocuments` is the credential store (`ownerType` ∈ operator/unit/job/trailer/carrier/user/equipment, `verificationStatus` ∈ needs_review/verified/rejected, `expiresAt`).
- `server/_core/storageKey.ts` validates minted storage keys; `server/storage.ts` is the storage edge.
- Migration `0168` retired the `/manus-storage/*` URL capability.

## Maps / routing

Substantial pure engine, **no live data path**.

- Road graph: `roadGraphBuilds`, `roadGraphNodes`, `roadGraphEdges`, `roadSegments`, `roadRestrictions`, `bridges`, `roadAdvisories`, `roadHazardObservations`.
- Route evaluation: `routeRequests`, `routeContexts`, `routeDecisions`, `routeApprovals`, `routeEvidenceEntries`.
- Communications/radio: `communicationCoverage`, `communicationPlans`, `communicationPolicies`, `radioChannels`, `roadRadioAssignments`, `companyRadioAuthorizations`, `unitRadioCapabilities`.
- **21 external data sources are declared** in `server/_core/externalSourceSeeds.ts` — 8 `verified`, **13 `unverified`**.
- **NOT IMPLEMENTED / NOT STARTED**: the feed scheduler. `feedScheduler`, `feedCollector`, `feedIngest`, `feedHttp`, `advisoryImpact`, `truckRoutingAdapter`, `osmImport`, `osmTopology`, `osmLoad`, `osmLoadPlan`, `map` are all in the repository's own declared-unwired list.

## Background jobs

- `server/_core/worker.ts` → `productionWorker.ts` — a database-polled workflow worker (`WORKFLOW_POLL_MS`, `WORKFLOW_BATCH_SIZE`, `WORKFLOW_WORKER_DISABLED`), with `workerLifecycle.ts` and `drainWorker.ts`. Built as `dist/worker.js`.
- `enforcementOutbox.ts` — enforcement events enqueued in the same transaction as the order.
- `heartbeat.ts` — declared unwired: *"liveness helper; no monitor calls it"*.

## Notification system

`server/_core/notification.ts` → `notifyOwner()` POSTs to the **Forge** service and **throws if `BUILT_IN_FORGE_API_URL` / `BUILT_IN_FORGE_API_KEY` are unset** (both default to `""`). Reached by exactly one procedure, `system.notifyOwner` (`adminProcedure`).

- **NOT IMPLEMENTED**: SMS, email (SMTP/SendGrid/Mailgun), push (FCM/APNs/web-push). No such dependency in `package.json`; the only `sms` hits in the tree are two string literals.

## AI / agent system

One real production path, gated on an unconfigured external endpoint.

- `server/_core/llm.ts` (458 lines) is a **hand-written OpenAI-shaped HTTP client**, not an SDK — `package.json` has **no** `openai`, `anthropic`, `langchain`, `@ai-sdk`, `ollama` or similar dependency.
- It targets `BUILT_IN_FORGE_API_URL` with `BUILT_IN_FORGE_API_KEY`; `assertApiKey()` throws when unset.
- **Exactly one production call site**: `server/routers.ts:691` — a voice transcript plus a form key becomes a structured **proposal** (`assistantProposals`, `commitState: "awaiting_readback"`). It never writes a domain record directly.
- Supporting modules that ARE wired: `assistantExtraction.ts`, `assistantPersistence.ts`, `assistantCommitService.ts`, `assistantCommitAdapters.ts`, `aiProposal.ts`, `_core/knowledge/`.
- `modelGateway` is declared unwired: *"no AI provider is configured yet"*.
- **NOT IMPLEMENTED**: multi-agent planner/executor/tester/reviewer architecture, local LLM, live chat surface.

## Mobile support

- **Android: NOT IMPLEMENTED.** No `android/` directory, no Capacitor dependency, plugins not installed.
- **iOS: NOT IMPLEMENTED.** No `ios/` directory.
- Web application: the only running surface.

## Deployment

- **NOT IMPLEMENTED** as repository artifacts. No Dockerfile, compose file, `.env.example`, Terraform, Kubernetes manifest or deployment runbook. `.github/` contains only `ci.yml` and a PR template. The entire production database configuration is one runtime variable, `DATABASE_URL`, supplied by the host. This is recorded in the repo's own `audit/hardening-2026-09-21/REMEDIATION.md:188`.
- CI runs the complete `scripts/ci-gate.sh` (gates 0–8) against MariaDB 10.11.

---

## Data flow 1 — a staff request

```
user (browser)
  → client/src  (tRPC React client)
  → POST /api/trpc/<path>                    server/_core/index.ts:54
  → createContext → sdk.authenticateRequest  server/_core/context.ts (JWT via jose, appId bound)
  → roleProcedure middleware                 server/_core/trpc.ts:71
        listActiveUserRoles(userId)           server/db.ts:1216   (revokedAt IS NULL)
        authorize({userId, grants, perm})     recordsAuthorization.ts:1978
        recordAuthorizationDecision(...)      ← ALWAYS, allow or deny
        sensitive permission + unrecordable audit → REFUSE
  → handler
        actingScopeFor(userId)                server/db.ts:801  (org, or refuse if ambiguous)
        <entity>InScope(id, scope)            → out of scope returns NOT_FOUND, never FORBIDDEN
  → service (server/*Service.ts) → Drizzle → MariaDB
  → domain audit row where the area defines one
```

## Data flow 2 — driver to billing

```
driver
  → dispatch.readiness / dispatch.evaluate            server/dispatchRouter.ts:53,68
  → composeReadiness(subject)                         server/readinessComposer.ts:202
        operator credentials  complianceDocuments
        Academy training      academyRequirementBindings → trainingDispatchDecision
        medical fitness       compliancePassport (projection only: "eligible", nothing more)
        unit                  maintenanceDefects + workOrderReleases
        insurance             insurancePolicies + coverages
        telematics faults     faultCodes
        route + comms         routeApprovals → planCommunications
        HOS                   hosAttestations (paper-log path)   [P8.3]
        enforcement           ** caller-supplied only — see GAPS **
  → evaluateDispatchReadiness(input)                  _core/dispatchReadiness.ts:152
        blockers: blocking | unknown | review, each overridable or not
  → P8.1 capability picture   readinessCapabilities.ts (PASS/REVIEW/BLOCKED/UNKNOWN/NOT_EVALUATED)
  → P8.2 automation policy    automationPolicyStore.ts  (snapshotted with the decision)
  → dispatchEligibilityChecks row + fingerprint
  → dispatch.award → decideAward                      _core/dispatchAward.ts:225
        blocking  → refuse unconditionally
        unknown/review → refuse unless a granted override covers it
        facts changed since the check → refuse
  → jobs / loads / manifests / disposalTickets
  → fieldTickets → per-line acceptance → signatures
  → billing readiness → invoices → commercialDocuments / auditPackages
```

Both flows are code-traced. Where a step does not exist, it is named in `GAPS_AND_DISCONNECTED_CODE.md`.
