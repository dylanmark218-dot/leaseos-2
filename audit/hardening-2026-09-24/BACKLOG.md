# LeaseOS 2 — Production Hardening, Security, Blockers & Next-Work Backlog

**Repository audited:** `leaseos-2-main`

**Repository release noted in current-state documentation:** v23.25

**Repository audit/hardening evidence reviewed:** 2026-09-21 security/hardening artifacts and current build/register documentation

**Scope:** source code, schema/migrations, CI, tests, security reports, architecture/register documents, runtime adapters, routing/compliance/AI infrastructure, and deployment-related files.

**Important limitation:** this is a source/repository audit, not a completed external penetration test or a fully executed production build. The environment could not fetch the package manager/runtime dependencies from the npm registry, so I did not claim a clean live install/build/test run. Items below that are marked “confirmed” are evidenced directly by repository source/configuration or the repository’s own audit documents. Items marked “hardening” are required controls or release work rather than claims that an exploit was reproduced.

---

## 1. Executive release assessment

LeaseOS has a mature domain and authorization foundation, but it is **not production-ready as a high-trust field/SaaS platform yet**.

The highest-risk gaps are not ordinary missing screens. They are the controls underneath the system:

1. dependency/supply-chain remediation
2. full tenant isolation and membership/offboarding semantics
3. HTTP edge security and request controls
4. server-side request forgery defenses for configurable URLs
5. secure document/evidence ingestion
6. session lifecycle and revocation
7. real Android/offline device implementation
8. production observability and deployment infrastructure
9. authoritative regulatory/routing data
10. browser/device end-to-end validation
11. completion of several compliance and commercial workflows
12. AI egress/provenance/tool-runtime governance before enabling autonomous/agent features

### Practical go/no-go rule

Do not call the platform “production ready” for real customer/driver/compliance/financial use until all **CRITICAL** items and the release-blocking HIGH items in Sections 2–10 are closed, or an explicit owner has accepted a documented risk with a compensating control.

---

# 2. CRITICAL — release blockers

## SEC-001 — Dependency and package-manager security

**Severity:** CRITICAL

**Status:** CONFIRMED / OPEN in repository hardening evidence

### Evidence

`audit/hardening-2026-09-21/pnpm-audit-after.json` records:

- 2 critical
- 39 high
- 61 moderate
- 8 low

The dependency graph includes vulnerable versions/paths involving packages such as `tar`, `vitest`, `vite`, `rollup`, `pnpm`, `postcss`, `picomatch`, `lodash`, `lodash-es`, `nanoid`, `form-data`, `path-to-regexp`, `qs`, `browserslist`, `dompurify`, and `mermaid`.

The repository also has package-manager drift:

- `package.json` `packageManager`: `pnpm@10.4.1+...`
- `devDependencies.pnpm`: `^10.15.1`
- lock resolution observed in the audit: pnpm 10.18.0

### Required work

- Upgrade vulnerable packages to patched versions.
- Pin one supported pnpm release and use it consistently in developer, CI, and production tooling.
- Regenerate `pnpm-lock.yaml`.
- Remove unnecessary production/development transitive exposure.
- Add dependency audit to CI as a hard gate for CRITICAL/HIGH findings.
- Generate an SBOM for every release.
- Add dependency provenance/signature checking where available.
- Add a documented exception process for vulnerabilities that cannot be upgraded immediately.

### Acceptance criteria

- Zero unresolved CRITICAL findings in the release dependency graph.
- HIGH findings are either zero or individually documented with exploitability analysis and compensating controls.
- `packageManager`, lockfile, CI toolchain and developer tool versions are identical by policy.
- SBOM attached to every release.

---

## SEC-002 — SSRF through arbitrary ArcGIS layer URLs

**Severity:** CRITICAL

**Status:** CONFIRMED from source

**Affected file:** `server/facilityDirectoryRouter.ts`

### Evidence

These procedures accept a user-supplied `layerUrl`:

- `facilityDirectory.arcgisInspect`
- `facilityDirectory.arcgisImportFromLayer`

The server then directly calls `fetch()` against the supplied URL.

`importFromLayer` additionally performs multiple server-side fetches and a server-side query against the supplied URL.

### Risk

A privileged user or compromised account could potentially cause the LeaseOS server to make requests to:

- loopback services
- private RFC1918 addresses
- cloud metadata services
- internal admin panels
- internal service ports
- other hosts reachable only from the server network

DNS rebinding and redirect-based SSRF must also be considered.

### Required work

Replace arbitrary URLs with a **registered-source model**:

```text
knowledgeSource / dataSource record
        ↓
approved host
        ↓
approved path prefix
        ↓
approved protocol
        ↓
fetch policy
```

For any remaining URL-based ingestion:

- permit only `https`
- allowlist hosts/domains
- resolve DNS before connection
- deny loopback, link-local, RFC1918, CGNAT, multicast, and cloud-metadata IP ranges
- re-check after DNS resolution
- re-check every redirect or disable redirects
- set connect/read/write timeouts
- cap response size
- reject unexpected content types
- restrict outbound ports to 443 unless explicitly approved
- log source identity and fetch result
- store source provenance

### Acceptance criteria

Security tests prove requests to private/loopback/metadata targets are refused, including redirect and DNS-rebinding test cases.

---

## SEC-003 — Webhook destination SSRF and outbound-request hardening

**Severity:** CRITICAL

**Status:** CONFIRMED from source

**Affected files:** `server/integrationRouter.ts`, `server/webhookDispatchService.ts`

### Evidence

Webhook subscription setup accepts an arbitrary HTTPS endpoint. Dispatch then performs an outbound `fetch()` to that endpoint.

### Risk

A tenant administrator or compromised privileged identity could point a webhook at an internal service. Webhook subscriptions therefore create a server-side outbound networking capability.

### Required work

- Reuse the same outbound SSRF policy used by ArcGIS ingestion.
- Prefer a validated destination registration over arbitrary free-form URLs.
- Resolve and validate destination IPs before connecting.
- Validate every redirect or disallow redirects.
- Add outbound timeout and maximum response handling.
- Add DNS-rebinding defenses.
- Add outbound network egress policy at infrastructure level as a second control.
- Add an allowlist option for enterprise deployments.
- Emit an audit event whenever a webhook endpoint is created or changed.

### Acceptance criteria

A server-side security test suite demonstrates that private-network targets cannot be reached from webhook dispatch.

---

## SEC-004 — Webhook duplicate-delivery race

**Severity:** HIGH / production-integrity blocker

**Status:** CONFIRMED from source

**Affected file:** `server/webhookDispatchService.ts`

### Evidence

Dispatch checks for the latest delivery row, computes the next attempt, sends the HTTP request, then inserts the delivery row. There is no atomic claim/lease around the delivery slot.

Two workers can therefore observe the same state and both attempt the same event.

### Risk

Duplicate external actions, especially dangerous when consumers are not perfectly idempotent.

### Required work

Use one of:

- transactional row claim/lease
- unique delivery key with atomic insert-before-send state machine
- queue-level single-owner delivery
- idempotency key contract

Every outbound webhook should include a deterministic idempotency key such as:

```text
subscriptionRef:eventId:attempt
```

and external consumers should be documented to deduplicate by event id.

### Acceptance criteria

Concurrency tests start multiple dispatch workers against the same event and verify that only one delivery attempt is created for a given delivery slot.

---

## SEC-005 — Production authentication can fall back to Bearer tokens from browser sessionStorage

**Severity:** HIGH

**Status:** CONFIRMED / DOCUMENTED AS OPEN

**Affected files:** `client/src/main.tsx`, `server/_core/sdk.ts`

### Evidence

The browser mirrors the session into `sessionStorage` and sends:

```text
Authorization: Bearer <session-token>
```

The server accepts a Bearer token fallback without restricting that path to development/preview mode.

### Risk

A JWT copied by injected frontend code, browser extension, compromised renderer, or other same-origin JavaScript becomes directly usable as a bearer credential.

The cookie flow’s `HttpOnly` property does not protect against this fallback because the token is deliberately exposed to JavaScript.

### Required work

Preferred architecture:

- production: cookie-only authentication where possible
- preview/dev compatibility: separate, explicitly development-only token path
- use a short-lived signed preview credential rather than the primary session JWT
- never mirror the real session token into browser storage in production

If a bearer path is unavoidable:

- require explicit `PREVIEW_AUTH_MODE=true`
- reject it automatically in production
- use a separate signing key and token issuer/audience
- make tokens short-lived
- scope them to a limited surface

### Acceptance criteria

Production browser bundles and server paths cannot use the preview bearer fallback.

---

## SEC-006 — One-year JWT sessions with no server-side revocation

**Severity:** HIGH

**Status:** CONFIRMED / DOCUMENTED AS OPEN

**Affected file:** `server/_core/sdk.ts`, `shared/const.ts`

### Evidence

`ONE_YEAR_MS` is the default session lifetime. The token is a stateless HS256 JWT and there is no general server-side session record/revocation check on every request.

### Risk

A stolen session token can remain valid for a very long time unless the signing secret is rotated.

### Required work

Move to a short-lived access session with refresh/session state:

```text
short-lived access token
        +
server-side refresh/session record
        +
rotation
        +
revocation
        +
device/session inventory
```

At minimum implement:

- 15–60 minute access session
- refresh rotation
- session ID / family ID
- server-side revocation
- “log out everywhere”
- device/session inventory
- last-used timestamp
- suspicious-session termination
- key rotation support

### Acceptance criteria

Revoked sessions stop working immediately or within a documented maximum cache window.

---

## SEC-007 — `SameSite=None` on the main session cookie requires explicit cross-site protections

**Severity:** HIGH

**Status:** CONFIRMED / DOCUMENTED AS OPEN

**Affected files:** `server/_core/cookies.ts`, OAuth flow

### Evidence

The main session cookie uses `SameSite=None`.

### Risk

Cross-site requests can carry the cookie. Even if most tRPC mutations are non-simple requests, the application should not depend on framework behavior as its primary CSRF defense when the session cookie is intentionally cross-site.

### Required work

- explicit allowed-origin policy
- Origin/Referer validation for state-changing requests
- a deliberate CSRF strategy for cookie-authenticated mutations
- separate cookies for narrowly scoped cross-site needs
- reduce `SameSite=None` use if the deployment architecture allows it

### Acceptance criteria

Cross-site mutation tests are included in the security suite and fail before reaching business logic.

---

## SEC-008 — No HTTP-layer security middleware / rate limiting

**Severity:** HIGH

**Status:** CONFIRMED / DOCUMENTED AS OPEN

**Affected file:** `server/_core/index.ts`

### Missing controls

No complete edge layer was found for:

- security headers
- global rate limiting
- differentiated authentication rate limiting
- request throttling
- CORS/origin policy
- body-size limits by route
- request timeouts
- slow-client protections

### Required work

Add:

- Helmet or equivalent explicit headers
- strict CSP appropriate to the frontend
- HSTS in HTTPS production
- `X-Content-Type-Options`
- `Referrer-Policy`
- `Permissions-Policy`
- frame/embedding policy
- global request rate limit
- route-specific rate limits
- login/MFA lockout limits
- upload rate limits
- webhook/integration rate limits
- AI endpoint limits
- request timeout and max duration controls
- explicit CORS/origin policy if cross-origin access is required

### Acceptance criteria

Load tests and abuse tests demonstrate rate limiting and request caps before application/database saturation.

---

## SEC-009 — 50 MB global JSON/urlencoded request body limit

**Severity:** HIGH

**Status:** CONFIRMED from source

**Affected file:** `server/_core/index.ts`

### Evidence

The global Express parsers use a 50 MB limit for JSON and URL-encoded bodies.

### Risk

A large body can consume memory/CPU and interfere with unrelated requests. Most application requests should be measured in kilobytes, not tens of megabytes.

### Required work

- set a small global JSON limit
- set route-specific limits for uploads or remove binary data from JSON entirely
- use direct-to-object-storage uploads for large files
- stream large payloads
- enforce request timeout
- enforce content-length and content-type requirements

### Acceptance criteria

Normal API routes reject oversized bodies well below 50 MB; upload endpoints are separately bounded.

---

## SEC-010 — Production runtime imports the development Vite stack

**Severity:** HIGH / packaging blocker

**Status:** CONFIRMED from source

**Affected files:** `server/_core/index.ts`, `server/_core/vite.ts`, `vite.config.ts`, `package.json`

### Evidence

`server/_core/index.ts` imports the Vite helper module while the Vite helper imports Vite and Vite config. Those packages are in `devDependencies`.

The production path does not call the Vite setup, but the module import itself is still part of startup/module evaluation.

### Risk

A true production install using `pnpm install --prod` or equivalent may not contain the development-only runtime dependencies needed merely to evaluate the module graph.

### Required work

Move development-server wiring behind a dynamic import or separate server entry point:

```text
production entry
  └── no Vite imports

development entry
  └── Vite imports
```

Do not solve this by promoting all devDependencies to production.

### Acceptance criteria

A clean production install with only production dependencies boots successfully and serves the built application.

---

# 3. HIGH — identity, tenancy and authorization

## AUTH-001 — Membership end does not necessarily revoke role grants

**Severity:** HIGH

**Status:** CONFIRMED by repository’s authorization investigation

### Evidence

The membership investigation in the build register shows that ending/suspending a membership prevents the old organization from being resolved through the membership path, but `userRoleAssignments` are independently considered active based on `revokedAt`.

A former member can therefore retain grants if those grants are not also revoked.

### Required work

Define one canonical offboarding transition:

```text
membership ended
      ↓
organization access revoked
      ↓
organization-scoped grants revoked
      ↓
portal identity revoked/suspended as appropriate
      ↓
active sessions invalidated
      ↓
refresh tokens revoked
      ↓
devices suspended where required
```

Do not rely on administrators to remember five separate actions.

### Acceptance criteria

An offboarding integration test proves that ending membership terminates access to all organization-scoped resources and future sessions.

---

## AUTH-002 — Single-tenant fallback remains a production SaaS boundary risk

**Severity:** HIGH for multi-tenant SaaS; MEDIUM for single-company deployments

**Status:** CONFIRMED from source/docs

### Evidence

`server/_core/actingScope.ts` contains a `SINGLE_TENANT_ID = "default"` fallback and documented `single_tenant_fallback` behavior.

### Required work

Choose one explicit product mode:

- single-company deployment
- multi-tenant SaaS

For SaaS:

- every tenant-owned record gets authoritative organization ownership
- “no current membership” is not silently converted to default tenant
- users with memberships but no live membership are refused or directed to an organization recovery flow
- remove the production fallback once all legacy data is migrated

### Acceptance criteria

Cross-tenant integration tests cover login, stale membership, direct IDs, portal identities, and legacy/unowned rows.

---

## AUTH-003 — Organization-scoping gaps remain in some compliance/evidence records

**Severity:** HIGH

**Status:** CONFIRMED / DOCUMENTED OPEN

### Evidence

`docs/compliance/follow-ups/TENANCY_UNSCOPED_COMPLIANCE_TABLES.md` and hardening notes identify compliance/evidence structures where tenant scope is not stored directly, including records such as compliance/evidence/seal/legal-hold/audit-package families and restricted passport-related paths.

Some world-fact tables are intentionally global; tenant-owned evidence must be distinguished explicitly.

### Required work

Build an ownership classification for every table:

```text
GLOBAL_WORLD_FACT
TENANT_OWNED
USER_OWNED
DEVICE_OWNED
SYSTEM_SHARED
```

For every `TENANT_OWNED` table:

- `orgRef` or an unambiguous authoritative ownership chain
- DB constraint/index
- router scope enforcement
- query helper
- cross-tenant tests

### Acceptance criteria

A generated schema report shows no unexplained tenant-owned table without an ownership invariant.

---

## AUTH-004 — Authorization map drift prevention

**Severity:** HIGH hardening

**Status:** Mostly built; improvement required

### Work

Keep the existing `roleProcedure()` model as canonical and add automated verification for:

- procedure → permission mapping
- permission → role mapping
- sensitive permission → fail-closed audit
- role grant → organization scope
- external portal procedure → external capability
- machine procedure → integration credential scope

The existing gate for zero bare `protectedProcedure` uses should remain.

### Acceptance criteria

A generated authorization matrix is published with every release and checked against the source registry.

---

# 4. HIGH — application/network security

## NET-001 — Secure proxy/TLS handling

**Severity:** HIGH hardening

### Evidence

Session-cookie security decisions consult `x-forwarded-proto`, while the application does not explicitly configure a trusted-proxy policy in the server startup code.

### Work

- Configure Express `trust proxy` to known proxy hops/IP ranges.
- Do not trust arbitrary forwarding headers when the app is directly exposed.
- Ensure TLS terminates at a known boundary.
- Set HSTS only when HTTPS is guaranteed.
- Add integration tests for direct, proxied, malformed, and conflicting scheme headers.

---

## NET-002 — Outbound HTTP policy needs one centralized egress service

**Severity:** HIGH

Instead of allowing feature routers to call `fetch()` directly, create:

```text
OutboundHttpService
  ├── allowlisted destinations
  ├── SSRF checks
  ├── DNS/IP policy
  ├── timeouts
  ├── redirect policy
  ├── response-size limits
  ├── tracing
  └── audit metadata
```

Migrate ArcGIS, webhooks, feeds, external providers and other server-side HTTP calls through it.

---

## NET-003 — Provider response/error messages can leak implementation details

**Severity:** MEDIUM/HIGH hardening

Review all places that throw external provider response text or raw exception messages.

Examples to review include:

- storage provider errors
- LLM provider errors
- external feed errors
- webhook errors
- OAuth errors

### Work

Return stable public error codes/messages to clients. Keep detailed provider responses in structured internal logs with secret redaction.

---

# 5. HIGH — documents, evidence and data protection

## DOC-001 — Malware and content scanning for uploads

**Severity:** HIGH / production blocker for document-heavy operations

### Evidence

Evidence upload paths accept base64 content and a declared MIME type. The application enforces a size limit but does not establish a complete malware/content validation pipeline.

### Required pipeline

```text
upload
 ↓
size limit
 ↓
content-type allowlist
 ↓
magic-byte validation
 ↓
malware scan
 ↓
archive/decompression safety
 ↓
content hash
 ↓
immutable storage
 ↓
metadata/provenance
 ↓
authorization
```

### Add protections for

- PDF bombs
- decompression bombs
- oversized images
- polyglot files
- MIME spoofing
- extension mismatch
- archive traversal
- nested archives
- executable payloads

---

## DOC-002 — Storage abstraction

**Severity:** MEDIUM/HIGH

### Evidence

`server/storage.ts` is tied to the configured Forge storage service.

### Work

Introduce a provider interface:

```text
StorageProvider
 ├── Forge
 ├── S3
 ├── S3-compatible
 ├── Azure Blob
 └── GCS
```

Every provider must support:

- immutable object write
- signed read URL
- signed upload URL
- content hash verification
- server-side metadata
- encryption at rest
- retention/hold flags

---

## DOC-003 — Highly restricted records need final privacy model

**Severity:** HIGH

### Evidence

The restricted vault code path is strong, but its own build register identifies an unresolved scope decision around:

- near misses
- drug & alcohol results
- internal investigations

Near-miss reports are not tier-gated by the restricted vault path, and drug/alcohol result storage is not implemented.

### Work

Owner decision + implementation:

- classify each sensitive category
- define roles allowed to know existence
- define roles allowed to view content
- define break-glass rules
- define legal hold behavior
- define retention
- define projections that reveal functional restrictions without diagnoses
- ensure ordinary list queries cannot expose existence or counts

---

## DOC-004 — Retention/legal hold completion

**Severity:** HIGH for compliance operations

Finish:

- retention policy enforcement
- legal hold application
- retention exceptions
- destruction eligibility calculation
- destruction job execution
- destruction receipt
- hold release
- retention audit trail
- data subject/export handling where applicable

Never destroy data merely because its nominal retention date has passed if a legal hold is active.

---

# 6. HIGH — sessions, secrets and key management

## KEY-001 — Secret lifecycle management

**Severity:** HIGH

### Current state

Production secret checks exist for `JWT_SECRET` and `VITE_APP_ID`.

### Missing lifecycle controls

- secret rotation procedures
- dual-key rotation windows
- key IDs/versioning
- emergency revocation runbook
- MFA encryption key rotation
- device-signing key rotation lifecycle
- backup encryption key management
- secret-manager integration

### Work

Introduce:

```text
KEY_VERSION
ACTIVE
NEXT
RETIRED
```

for signing/encryption keys where applicable.

---

## KEY-002 — Separate runtime DB credentials from migration credentials

**Severity:** HIGH security hardening

Do not run the application with a DB principal that can perform arbitrary schema migrations.

Create at least:

```text
runtime_db_user
migration_db_user
readonly_reporting_user (optional)
backup_operator (separate where supported)
```

---

## KEY-003 — Backups must be encrypted and restore-tested

**Severity:** CRITICAL operational blocker

### Current finding

No complete backup/restore implementation or checked-in operational restore workflow was found in the repository.

### Work

Implement/document:

- automated database backups
- point-in-time recovery where supported
- object-storage backup/versioning
- encrypted backup artifacts
- backup retention
- cross-region or cross-zone copy policy as required
- restore procedure
- restore drill
- RPO/RTO targets
- disaster recovery runbook

### Acceptance criteria

A scheduled restore test can recreate a production-like environment from backup and verify application-level integrity.

---

# 7. HIGH — runtime/deployment/operations

## OPS-001 — No complete checked-in production deployment definition

**Severity:** HIGH / operational blocker

### Evidence

The repository does not contain a complete production Docker/Kubernetes/Compose/systemd/Terraform-style deployment definition.

### Work

Choose and document the target deployment architecture.

At minimum include:

- container build
- immutable image tag
- runtime user (non-root)
- health endpoint
- readiness endpoint
- graceful shutdown
- CPU/memory limits
- environment configuration
- secret injection
- database connectivity
- worker deployment
- object storage
- network egress policy
- TLS/ingress
- logs/metrics
- scaling

---

## OPS-002 — Health and readiness endpoints

**Severity:** HIGH

### Evidence

The system health procedure only reports a trivial healthy response; it does not establish true readiness of the application stack.

### Work

Create:

```text
GET /health/live
GET /health/ready
```

Readiness should check, within safe time limits:

- database reachability
- migration compatibility
- worker availability or queue dependency
- storage configuration
- required external provider configuration

Do not make health checks depend on expensive business queries.

---

## OPS-003 — Structured observability

**Severity:** HIGH

### Current state

The application primarily logs through `console.log/warn/error`.

### Work

Adopt structured logging with:

- timestamp
- level
- request ID
- trace ID
- user ID
- organization ID
- procedure
- route
- duration
- outcome
- error class
- correlation ID
- worker ID
- job/trip/aggregate reference where appropriate

Add metrics for:

- request rate
- latency
- 4xx/5xx
- DB latency
- queue depth
- worker lag
- retry count
- dead letters
- webhook failures
- sync failures
- upload scanning failures
- AI latency/tokens/cost if AI enabled

---

## OPS-004 — Worker reliability controls

**Severity:** HIGH

Finish:

- heartbeat
- job claim/lease
- stale-worker recovery
- dead-letter queue
- retry budget
- queue depth metric
- stuck job detector
- operator-visible failures
- graceful worker shutdown
- duplicate worker tests

---

## OPS-005 — Production port behavior

**Severity:** MEDIUM/HIGH

The server currently attempts alternative ports after the preferred port is unavailable.

### Work

- production: fail fast if configured port cannot bind
- development: fallback behavior may remain

A production process silently choosing a different port can make a load balancer point at a dead endpoint.

---

# 8. HIGH — field/mobile runtime

## MOBILE-001 — Android/Capacitor shell

**Severity:** CRITICAL for field/mobile product

### Evidence

`client/src/runtime/adapters/capacitor.ts` contains native-only error paths and expects plugins that are not installed/configured as the completed native runtime.

### Required work

Build:

- Capacitor Android project
- release signing
- app identity
- device enrollment
- activation
- revocation
- key rotation
- offline DB
- secure storage
- camera
- GPS
- notifications
- biometric unlock

---

## MOBILE-002 — Encrypted SQLite with Android Keystore

**Severity:** CRITICAL for offline field data

Use SQLCipher or an equivalent supported encrypted database.

Requirements:

- encryption key wrapped by Android Keystore
- no database key in JS local storage
- secure wipe on device revoke
- lock/timeout policy
- backup exclusion policy where appropriate
- migration tests on device

---

## MOBILE-003 — Encrypted file vault

**Severity:** CRITICAL for offline evidence

Implement encrypted local file storage for:

- photographs
- PDFs
- SDS files
- completion documents
- captured signatures
- offline evidence packages

The file key must not be stored in plain application storage.

---

## MOBILE-004 — Device biometric signing

**Severity:** HIGH

The server-side attestation framework exists. The device-side operation is incomplete.

Finish:

- platform biometric prompt
- hardware-backed P-256 key
- signing payload creation
- attestation generation
- device enrollment proof
- revocation handling
- key rotation
- signature failure UI

Do not store biometric templates or raw biometric material.

---

## MOBILE-005 — GPS breadcrumb queue

**Severity:** HIGH

Build offline capture for:

- GPS timestamp
- coordinates
- accuracy
- source type
- device time
- monotonic sequence
- signature where appropriate

Queue locally and synchronize after connectivity restoration.

---

## MOBILE-006 — Clock skew workflow

**Severity:** HIGH

Server support exists. Device UX remains.

Implement:

- stop-and-prompt state
- server-time display
- network-time guidance
- no destructive queue clearing
- retry only when retryable

---

## MOBILE-007 — Native CI / physical-device test matrix

**Severity:** HIGH

Add Android emulator tests plus a real-device release validation suite.

Cover:

- install/update
- enrollment
- offline mode
- capture
- sync recovery
- revoked device
- rotated device key
- biometric unavailable
- low storage
- low battery
- clock skew
- camera denied
- GPS denied
- notification denied

---

# 9. HIGH — routing, communications and external data

## ROUTE-001 — Province-wide routing provider

**Severity:** HIGH / product blocker

### Current state

`server/_core/routingSource.ts` is still `not_loaded` / `configured_not_implemented` for the external routing provider path.

### Work

Implement approved routing provider behind the existing evaluator:

```text
legal
physical
operational
confidence
```

Every route result should preserve:

- provider
- dataset version
- jurisdiction
- retrieval time
- verification date
- restrictions considered

`UNKNOWN` must remain distinct from `PASS`.

---

## ROUTE-002 — Alberta 511 commercial licensing/permission

**Severity:** HIGH product/legal blocker

An API key being present is not equivalent to having permission for commercial redistribution/use.

### Work

- obtain/document permission
- store licence/source record
- enforce source gate
- record source version
- define caching/redisplay rights
- test denial when permission is absent

---

## ROUTE-003 — Commercial mapping resource datasets

**Severity:** HIGH

Verify and maintain source data for:

- fuel/cardlock
- DEF
- water
- disposal
- scales
- weigh stations
- parking
- washout
- repair
- commercial facilities

Each record needs provenance, effective time and verification status.

---

## COMMS-001 — Communications source adapters

**Severity:** MEDIUM/HIGH

The system models communications channels and coverage, but source adapters for ISED/BC/CRTC-type datasets are not fully implemented.

Finish only from legally usable sources and keep public vs company-private channels distinct.

---

# 10. HIGH — compliance and regulatory authority

## HOS-001 — Verify seeded HOS figures before production authority

**Severity:** CRITICAL for automated HOS decisions

### Evidence

The current build register explicitly keeps at least one HOS value contested and requires human verification of other seeded figures.

### Work

For each rule:

- authoritative source
- section/clause
- jurisdiction
- effective dates
- verification method
- author
- approver
- promotion history

Do not turn unverified data into automatic enforcement.

---

## HOS-002 — Complete manual/paper fallback paths

**Severity:** HIGH

The HOS path has a working paper/scanned/manual design, but analogous manual paths remain for other capabilities.

Build and test manual fallback semantics for each remaining capability.

Important rule:

```text
manual attestation ≠ computed authority
```

and must not silently enter automated calculations as if it were measured truth.

---

## COMP-001 — Unified compliance engine gaps

**Severity:** HIGH

Documented gaps include:

- licence class/endorsement checks not incorporated authoritatively by the composer path
- a second shift-readiness system that does not necessarily call the unified composer
- `unitHeld` incident logic not consumed by the composer

### Work

Create exactly one readiness composition path.

All inputs should be authoritative server-side data, not client-provided profile objects.

---

## COMP-002 — Safety floor owner decision

**Severity:** HIGH governance blocker

Define which capabilities may never be `AUTO`, even for owner-operators.

Examples may include critical mechanic release or similarly safety-sensitive actions.

The application must not invent this list.

---

## COMP-003 — Regulatory-change management

**Severity:** HIGH

Implement:

- source watch
- version promotion
- impact assessment
- effective-date scheduling
- pending review dashboard
- supersession tracking
- rollback/deprecation policy

---

# 11. HIGH — finance/commercial integrity

## FIN-001 — Deterministic trip-to-money pipeline

**Severity:** HIGH

Remaining portfolio work includes stronger automation from:

```text
operational completion
 → accepted lines
 → evidence snapshot
 → deterministic billing proposal
 → customer approval where required
 → invoice
 → payment
 → reconciliation
 → period close
```

Keep proposal/finalization separation.

---

## FIN-002 — Automatic billing projection call site

**Severity:** HIGH

The billing projection engine exists but requires its production call site.

Add:

- trigger/event source
- idempotency
- proposal version
- source snapshot hash
- reviewer route
- finalization path

---

## FIN-003 — Customer partial-acceptance configuration

**Severity:** MEDIUM/HIGH

The system treats `NULL` as review rather than implicit permission. That is safer than guessing, but production must require an explicit account policy before billing behavior depends on it.

---

## FIN-004 — Purchase-order limit precedence

**Severity:** HIGH governance blocker

The register identifies PO limit tiers that are not currently authoritative for the existing purchase-order path.

Resolve precedence and wire it into the final authorization/budget decision.

---

## FIN-005 — Final-pay/offboarding calculation

**Severity:** HIGH if payroll is part of launch scope

Complete and test:

- final wages
- approved expenses
- outstanding advances
- deductions
- statutory treatment
- closeout
- audit evidence

---

# 12. MEDIUM/HIGH — AI Secretary and AI runtime

## AI-001 — Provider fail-closed

**Severity:** HIGH / security

### Evidence

`server/_core/llm.ts` can use a hard-coded vendor host when `BUILT_IN_FORGE_API_URL` is not set, while production secret validation does not require explicit provider configuration.

### Required work

Production should require:

```text
provider configured
endpoint configured
model configured
credential configured
policy allows data class
```

No silent fallback destination.

---

## AI-002 — AI data egress classification

**Severity:** HIGH

Before any AI feature is production-enabled, classify inputs:

```text
PUBLIC
INTERNAL
CONFIDENTIAL
PERSONAL
REGULATED
RESTRICTED
```

The AI gateway should reject prohibited classes automatically.

---

## AI-003 — Run provenance persistence mismatch

**Severity:** HIGH

`RunProvenance` promises provider/model/prompt version/hash/input hash, but the proposal schema does not fully persist the declared provenance.

### Work

Persist:

- provider
- model
- prompt version
- prompt hash
- normalized input hash
- correlation ID
- request ID
- created time

---

## AI-004 — Tool execution receipts

**Severity:** HIGH

`ToolResult` is returned but not durably recorded as a complete execution receipt; `agentActions.outcome` remains at `requested` in the current architecture.

Every tool call must record:

- tool key
- version
- decision
- outcome
- started/completed
- result hash
- correlation ID
- user/organization scope

---

## AI-005 — Runtime budget enforcement

**Severity:** HIGH

`agentRuns.maxSteps` and `stepsUsed` exist but are not fully enforced.

Implement:

```text
if stepsUsed >= maxSteps → refuse
else → increment atomically before next action
```

The model must not be able to increase its own cap.

---

## AI-006 — AI inference telemetry

**Severity:** MEDIUM/HIGH

Record:

- provider
- model
- latency
- token usage
- failure class
- cost where provider supplies it
- correlation/job ID
- retry count

---

## AI-007 — Prompt/extraction consolidation

**Severity:** MEDIUM

There are parallel prompt/extraction contracts:

- inline prompt construction
- versioned prompt files
- `RawSlot`
- `ExtractedField`

Select one canonical schema and retire duplicates only after the production seam is stable.

---

## AI-008 — Keep chain-of-thought out of durable storage

**Severity:** DESIGN REQUIREMENT

Do not add tables or fields for model hidden reasoning/scratchpads.

Persist auditable artifacts, evidence references, decisions and tool receipts instead.

---

# 13. MEDIUM/HIGH — testing

## TEST-001 — Browser E2E suite

**Severity:** HIGH / release blocker

Build Playwright coverage for at least:

### Dispatcher

login → create job → assign operator → assign unit → readiness → dispatch → completion

### Operator/driver

login → assignment → pre-departure cache → offline mode → evidence capture → signature → sync

### Customer

invitation → authentication → review → sign → dispute/accept → completion package

### Finance

accepted job → invoice → finalization → payment → reconciliation → period close

### Compliance

unknown → review → verification → promotion → readiness effect

### Admin

role grant → revoke → offboarding → audit review

---

## TEST-002 — Device E2E

**Severity:** HIGH

Add emulator/physical-device tests for offline behavior, key storage, camera, GPS, biometric signing, sync, clock skew and revoke.

---

## TEST-003 — Security regression suite

**Severity:** HIGH

Automate tests for:

- cross-tenant reads
- IDOR/BOLA
- role escalation
- revoked memberships
- revoked portal identities
- webhook SSRF
- ArcGIS SSRF
- redirect SSRF
- malformed bearer tokens
- CSRF
- oversized requests
- file type spoofing
- path traversal
- storage-key traversal
- sensitive audit fail-closed behavior

---

## TEST-004 — Upgrade-migration testing

**Severity:** HIGH

The clean database migration gate is valuable but does not prove upgrade safety.

Add an upgrade matrix:

```text
N-2 → N-1 → N
N-1 → N
```

including real production-like data volumes and migration rollback/failure exercises.

---

## TEST-005 — Backup/restore test

**Severity:** CRITICAL operational blocker

A release should not pass the operational gate unless backup restoration has been verified within the target RTO/RPO.

---

## TEST-006 — Load/performance testing

**Severity:** MEDIUM/HIGH

Test:

- API throughput
- concurrent logins
- dispatch board
- search
- document operations
- webhook delivery
- worker throughput
- large organizations
- high evidence volume
- mobile sync bursts

---

## TEST-007 — Chaos/failure testing

**Severity:** MEDIUM/HIGH

Inject:

- DB outage
- storage outage
- provider timeout
- worker crash
- duplicate worker
- webhook timeout
- network partition
- clock drift
- partial upload

and verify safe recovery.

---

# 14. MEDIUM — frontend/UI/UX and performance

## UI-001 — Accessibility coverage expansion

**Severity:** MEDIUM/HIGH

Current jsdom axe coverage is useful but incomplete.

Add Chromium accessibility scans for:

- color contrast
- target size
- viewport behavior
- focus/scroll
- keyboard navigation
- dialog focus trapping
- screen reader names

---

## UI-002 — Route-level lazy loading / bundle optimization

**Severity:** MEDIUM

The current-state documentation reports a large primary bundle.

Work on:

- route-level lazy loading
- chart library splitting
- map code splitting
- showcase route exclusion from production
- AI UI lazy load
- portal-specific bundles

---

## UI-003 — Disable/exclude showcase functionality in production

**Severity:** MEDIUM/HIGH

The showcase guard is a good defense, but production builds should ideally not ship demonstration functionality at all.

Create separate build modes:

```text
LeaseOS production
LeaseOS demo/showcase
```

---

## UI-004 — Production-grade error/loading/empty states

Audit every major workflow for:

- loading
- retry
- permission denied
- stale data
- offline state
- partial sync
- missing evidence
- review state
- unknown state
- conflict state

---

# 15. MEDIUM — database/schema/architecture maintainability

## DB-001 — Domain ownership catalog for 410 tables

**Severity:** MEDIUM/HIGH

The schema has grown to 410 tables. Maintain a machine-readable table ownership registry:

```text
Table → Domain → Tenant model → Owner procedure set → Retention class → Sensitivity
```

Domains should include, where applicable:

- Identity
- Organizations
- Operations
- Dispatch
- Fleet
- Compliance
- Documents
- Commercial
- Finance
- Workforce
- Training
- Communications
- Spatial
- Integrations
- AI
- Device Runtime
- Audit

---

## DB-002 — Transaction and locking review of critical state transitions

**Severity:** HIGH hardening

Audit all operations that change:

- approvals
- signatures
- invoice finalization
- payment/reconciliation
- role grants
- membership status
- device state
- compliance promotion
- legal hold
- webhook delivery state

Every critical transition must have an explicit concurrency strategy.

---

## DB-003 — Index/constraint audit

Review every high-volume table for:

- foreign keys
- uniqueness
- tenant-prefixed indexes
- status/date indexes
- common query indexes
- orphan prevention
- race-resistant uniqueness

Especially review tables that depend on semantic uniqueness implemented only in application code.

---

## DB-004 — Timestamp/data-range policy

The membership investigation found MariaDB `TIMESTAMP` range constraints ending in 2038.

### Work

Define and standardize:

- UTC storage
- `DATETIME` vs `TIMESTAMP` policy
- indefinite dates as `NULL`
- far-future date rejection
- timezone normalization
- leap/offset handling

---

# 16. MEDIUM — migration and release engineering

## MIG-001 — Make dangerous baseline operations hard to misuse

`migrate.ts baseline --yes` is intentionally powerful.

Add stronger safeguards:

- explicit environment marker
- expected schema fingerprint
- production deny-by-default
- one-time unlock token
- operator ID
- audit record
- post-baseline validation

---

## MIG-002 — Migration failure recovery strategy

MySQL/MariaDB DDL is not uniformly rollback-safe.

Implement:

- preflight
- backup checkpoint
- compatibility validation
- destructive-change detection
- post-migration smoke tests
- recovery runbook

---

## MIG-003 — Reconcile migration collision register/documentation

The repository has historical/reserved migration numbers and a collision register.

Keep it synchronized with the actual migration head and branch integration state.

Do not let documentation claim an older migration head after a later migration is already integrated.

---

# 17. MEDIUM — legal, privacy and governance

## LEGAL-001 — Finish legal document register

**Severity:** HIGH before commercial launch

The legal register marks most instruments as `DRAFT-PK`.

Complete and sign off, with owners and dates, for at least:

- terms of service
- website/cookie notice
- accessibility statement
- client portal terms
- order form/pricing/renewal
- SOW/change order
- DPA/subprocessor register
- GPS/employee monitoring notice
- AI/OCR/voice policy and impact assessment
- e-signature evidence policy
- retention/destruction/legal hold procedure
- SLA/support policy
- pilot/beta agreement
- developer/contractor IP/NDA
- API developer terms
- security addendum
- vulnerability disclosure policy
- insurance/risk-transfer schedule
- IP/trademark register
- corporate governance checklist
- privacy impact assessment
- master legal/compliance manual

---

## LEGAL-002 — Complete third-party notices/SBOM

**Severity:** HIGH for public/commercial release

MIT is declared, but third-party notices/SBOM are not yet a complete tracked release artifact.

Generate automatically from the actual lockfile and retain with releases.

---

## PRIV-001 — Employee GPS/privacy governance

**Severity:** HIGH if driver tracking is enabled

Define:

- purpose limitation
- minimum collection
- retention
- who can access location history
- after-hours behavior
- geofence retention
- employee notice
- policy exceptions
- audit access

---

# 18. MEDIUM — notifications and communications

## NOTIFY-001 — Production notification providers

**Severity:** HIGH if operational alerts are part of launch

The product has alerting logic but no complete production delivery layer for all channels.

Implement a provider abstraction for:

- email
- SMS
- push
- optionally voice

with:

- delivery receipt
- retry
- dead letter
- opt-out/preference handling
- throttling
- template versioning
- auditability

---

## NOTIFY-002 — Notification policy and preference center

Define who can be notified about:

- dispatch changes
- safety blockers
- compliance expiry
- maintenance
- invoices
- approvals
- security events
- sync problems

Never assume every user wants every channel.

---

# 19. MEDIUM — remaining product/build register items

These are not all security blockers, but they are unfinished capabilities explicitly recorded by the repository.

## BUILD-001 — Printable Academy assessment sheets served/offline

Procedures exist; printable HTML serving and offline cache behavior remain.

## BUILD-002 — `CA_FEDERAL_NORTH60.daily_on_duty_minutes`

Still contested in the seed; requires human verification.

## BUILD-003 — Site baseline router/tables/alert wiring

Core engine exists; production route and alert integration remain.

## BUILD-004 — Trip-to-billing automation

Deterministic proposal, post-trip package and machine bill/ticket ingestion remain across the portfolio.

## BUILD-005 — Trip passport package generation completion

Engine exists; tables/completion decision remain.

## BUILD-006 — Digital safety binder

Requirement seeding and office task queue remain.

## BUILD-007 — Policy portfolio

Policy entities and lifecycle need completion where still listed as open.

## BUILD-008 — Remote camp module

Still listed in the master portfolio as open; verify current intended scope before implementing.

## BUILD-009 — Notification delivery channels

External email/SMS/push providers remain to be implemented if in launch scope.

## BUILD-010 — Measured fluids inventory

Still listed in the portfolio; implement only after confirming domain scope.

## BUILD-011 — Commercial Office approval queue/ladder UI

Backend foundations exist; remaining office screens/navigation are listed as partial.

## BUILD-012 — Contracts as operational records

Complete if contracts are intended to be first-class operations objects rather than attachments.

---

# 20. MEDIUM — integrations and machine clients

## INT-001 — Machine-client lifecycle

Complete:

- credential issuance
- secret rotation
- scope restriction
- IP/network policy where needed
- expiry/revocation
- integration health
- inbound replay defense
- idempotency
- payload schema versioning

---

## INT-002 — Inbound replay/idempotency review

For every machine feed:

- idempotency key
- payload hash
- source client
- source timestamp
- clock skew handling
- duplicate response semantics
- event replay protection

---

## INT-003 — External connector contract tests

Build contract tests for every external API/provider that exists in production configuration.

---

# 21. LOWER priority but important engineering cleanup

## CLEAN-001 — Dead/duplicate feature paths

Consolidate duplicate or legacy pathways before they become permanent:

- old manifest party representations
- duplicate prompt/extraction models
- duplicate readiness paths
- legacy route references
- legacy role/admin pathways where domain RBAC supersedes them

---

## CLEAN-002 — Canonical widget source contract

The widget registry currently conflates:

- authorization
- data source
- truth origin

Implement the split represented by `widgetSourceContract.ts`.

---

## CLEAN-003 — Generated architecture map

Generate a machine-readable architecture inventory from the repository each release:

- routes
- procedures
- permissions
- tables
- migrations
- external services
- jobs
- clients
- device-only capabilities

---

## CLEAN-004 — Remove generic template remnants

The repository still contains template files with TODOs such as `template.json`. These are not necessarily runtime defects, but they should not be mistaken for canonical product code.

Move samples/templates to an explicit `examples/` or delete them before public release.

---

# 22. Existing findings that were already fixed — DO NOT regress them

The repository’s 2026-09-21 security audit documents several findings as fixed. They should stay closed and remain protected by regression tests:

1. branch-confined grant laundering into global roles
2. restricted passport private-detail disclosure
3. restricted vault by-ID paths missing organization scope
4. restricted vault mutations not failing closed
5. untiered restricted-vault reads without audit
6. storage-key path validation
7. session `appId` mismatch enforcement
8. production JWT secret length guard
9. test type-checking ratchet
10. authorization ordering and bare protected-procedure gate

Do not reintroduce alternate code paths that bypass the canonical gates.

---

# 23. Required security architecture after remediation

LeaseOS should converge on the following request flow:

```text
Internet / Device / Portal / Integration
                |
                v
        TLS / WAF / Proxy
                |
                v
   Origin + rate limit + timeout
                |
                v
       Authentication layer
                |
                v
      Organization resolver
                |
                v
      Permission / role gate
                |
                v
     Tenant ownership check
                |
                v
      Input validation
                |
                v
      Business rule engine
                |
                v
      Transaction / lock
                |
                v
      Audit / evidence
                |
                v
       Durable mutation
                |
                v
        Outbox / event
                |
                v
       Async worker/queue
                |
                +----> Notifications
                +----> Webhooks
                +----> Integrations
                +----> AI proposal
```

No external or AI operation should jump around this chain.

---

# 24. Recommended production execution order

## Wave 0 — freeze feature expansion

No major new feature work. Only security, correctness, deployment and release blockers.

## Wave 1 — security floor

1. dependency upgrades
2. SSRF control service
3. webhook concurrency/idempotency
4. production auth mode split
5. session revocation architecture
6. security headers
7. rate limiting
8. CSRF/origin policy
9. request limits/timeouts
10. secure proxy configuration

## Wave 2 — tenant/data boundary

11. organization ownership inventory
12. remove dangerous default fallback for SaaS mode
13. membership/offboarding transaction
14. revoke organization grants on offboarding
15. tenant scope for compliance/evidence/restricted records
16. sensitive data classification

## Wave 3 — data durability/security

17. upload malware/magic-byte scanning
18. object storage abstraction
19. backup/restore
20. database least privilege
21. key rotation
22. retention/legal hold

## Wave 4 — production infrastructure

23. production Docker/container
24. deployment definition
25. health/live/readiness
26. structured logs
27. metrics
28. tracing
29. worker heartbeat/dead letters
30. alerting

## Wave 5 — regulatory truth

31. HOS source verification
32. compliance composer gaps
33. safety floor decision
34. regulatory-change workflow
35. 511 licensing permission
36. mapping source verification
37. communications data adapters
38. routing provider

## Wave 6 — field device

39. Android shell
40. encrypted SQLite
41. Keystore
42. camera/evidence capture
43. GPS breadcrumb queue
44. biometric signing
45. secure file vault
46. device notifications
47. native test matrix

## Wave 7 — business completion

48. billing automation
49. completion packages
50. safety binder
51. commercial approval ladder UI
52. notifications
53. remaining portfolio modules confirmed for launch

## Wave 8 — release verification

54. Playwright E2E
55. security regression suite
56. load tests
57. migration upgrade tests
58. backup restore test
59. failure injection
60. accessibility/Chromium audit
61. staging deployment rehearsal
62. production runbook rehearsal

---

# 25. Production release gate

A LeaseOS release should not be marked production-ready unless the release evidence package can answer all of these:

### Security

- Are all critical dependency findings closed?
- Can any caller reach another tenant’s data by ID?
- Can any privileged feature make arbitrary internal HTTP requests?
- Can a revoked person/device/session still act?
- Are upload contents scanned and validated?
- Are security headers/rate limits/origin protections active?
- Are secrets rotated and stored outside source/config history?

### Data

- Does every tenant-owned record have an ownership invariant?
- Can the database be restored from backup?
- Are migrations upgrade-safe?
- Are retention/legal hold rules enforced?

### Operations

- Does the application expose live/readiness signals?
- Are logs/metrics/traces present?
- Are workers monitored?
- Are alerts actionable?
- Is deployment reproducible from source?

### Field

- Does offline mode work on real hardware?
- Can evidence be captured without network?
- Can the device sign using hardware-protected keys?
- Does GPS queue and replay safely?
- Can a revoked device be disabled?

### Regulatory

- Are every auto-enforced rule verified to an authoritative source?
- Are unknowns still unknown rather than guessed?
- Are source version/effective dates stored?
- Can an auditor reconstruct why an automatic decision was made?

### Business

- Can an accepted job deterministically become money?
- Can customers approve/dispute?
- Can finance reconcile and close a period?
- Are notifications delivered?
- Are external portals scoped correctly?

### Testing

- Clean DB gate passes
- Upgrade migration tests pass
- Browser E2E passes
- Device E2E passes
- security suite passes
- load/performance gate passes
- backup restore passes
- accessibility gate passes

---

# 26. Final critical analysis

LeaseOS’s strongest asset is its **truth/authorization architecture**: permissions are enforced server-side, sensitive authorization can fail closed if auditing fails, the system distinguishes unknown from false, many operations use immutable snapshots/hashes, and AI actions are designed around proposal → evidence → confirmation → commit rather than direct model mutation.

The biggest risk is now **complexity without a final production boundary**. The application has enough domains, tables, procedures and integrations that continuing to add features before finishing the platform controls will increase the cost of every future change.

The next engineering objective should therefore be:

> **Make the existing system safe, tenant-correct, observable, recoverable, device-capable and authoritative before expanding its surface area.**

The repository is already beyond the point where “add the missing screen” is the primary development strategy. It needs a release-hardening program with explicit owners, evidence, automated gates and real-device/real-environment validation.

---

# 27. Suggested project tracking labels

Use these labels in the engineering issue tracker:

- `P0-BLOCKER`
- `P1-SECURITY`
- `P1-TENANCY`
- `P1-DATA`
- `P1-DEVICE`
- `P1-COMPLIANCE`
- `P1-OPS`
- `P2-RELIABILITY`
- `P2-TESTING`
- `P2-PERFORMANCE`
- `P3-UI`
- `P3-CLEANUP`
- `HUMAN-VERIFICATION`
- `LEGAL-OWNER`
- `EXTERNAL-LICENSE`

Each issue should contain:

```text
Owner
Status
Severity
Affected files
Affected procedure/table/domain
Risk
Required change
Migration required?
Test required?
Operational proof
Rollback plan
Acceptance evidence
```

---

# 28. Immediate top-20 work queue

1. Upgrade and reconcile pnpm/dependency security.
2. Remove production dependency on Vite/dev modules.
3. Build centralized outbound HTTP/SSRF policy.
4. Lock down ArcGIS ingestion.
5. Lock down webhook destinations.
6. Make webhook delivery concurrency-safe/idempotent.
7. Remove production sessionToken exposure to sessionStorage/Bearer fallback.
8. Implement short-lived sessions + revocation.
9. Add security headers, origin/CSRF policy and rate limiting.
10. Reduce global body limits and add upload streaming.
11. Finish tenant ownership audit and organization-scoped compliance/evidence data.
12. Implement true membership/offboarding revocation.
13. Build backup/restore and disaster-recovery workflow.
14. Add structured observability + health/readiness.
15. Separate DB runtime and migration credentials.
16. Finish secure document scanning pipeline.
17. Verify HOS/regulatory rules before enabling automatic enforcement.
18. Implement province-wide routing provider and licensing/source gates.
19. Build Android/offline field runtime.
20. Build Playwright + native E2E release gates.

---

**Bottom line:** LeaseOS has a serious foundation. The remaining work is mostly about turning that foundation into a defensible production system: secure boundaries, reliable operations, authoritative data, real field hardware, and evidence-backed release gates.
