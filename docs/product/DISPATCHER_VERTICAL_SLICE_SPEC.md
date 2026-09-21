# Dispatcher vertical slice — implementation specification

**Baseline** `main` @ `f21cd1bc2070ae179d431177fd0f286965e0f3c3` (v23.25).
**Status**: specification. Nothing implemented. Detailed enough to be built test-first.

Every procedure below was read in its implementation, not inferred from its name.

---

# A. The existing backend, traced

## A.1 The dispatch gate — `server/dispatchRouter.ts` (173 lines)

Its own header states the design: *"The caller supplies identities. Every fact is loaded here."*

### `dispatch.readiness` — query · permission `dispatch.read`
- **Roles**: dispatcher, office, management, auditor
- **Input** `SUBJECT` = `{ operatorId: int+, unitId: int+|null, trailerId?: int+|null, jobId?: int+|null, routeApprovalRef?: string(64)|null, loneWorker?: boolean }`
- **Output** `{ verdict, explanation, blockers: DispatchBlocker[], contributions: {engine,finding}[] }`
- **Calls** `composeReadiness(...)` → `evaluateDispatchReadiness(...)`
- **Tables** read-only across ~20 (operators, units, complianceDocuments, maintenanceDefects, workOrderReleases, insurancePolicies, faultCodes, routeApprovals, academy*, hosAttestations …)
- **Audit** authorization row only. **Writes nothing** — it is a preview.
- **Scope** none of its own. It takes ids and loads facts; it does **not** call `actingScopeFor`. See **K-1**.
- **Tests** exercised throughout `dispatchGate.test.ts`. **UI: none.**

### `dispatch.evaluate` — mutation · permission `dispatch.evaluate`
- **Roles**: dispatcher, safety, office, management
- **Input** `SUBJECT` + `{ postingId?: int+|null, roleId?: int+|null }`
- **Refuses** `BAD_REQUEST` when neither `postingId` nor `jobId` is given: *"A check needs a postingId or a jobId"*. `NOT_FOUND` if the posting does not exist.
- **Output** `{ checkId, verdict, explanation, blockers, fingerprint, evaluatedAt, contributions }`
- **Writes** one `dispatchEligibilityChecks` row carrying `verdict`, `blockersJson`, `fingerprint`, **`capabilitiesJson`** (0152 — the capability picture *including what was not evaluated*), **`capabilityVerdict`**, **`automationPolicyJson`** (0153), `evaluatedByUserId`, `routeApprovalRef`.
- **Why stored, not recomputed** (from the source): *"recomputing would answer with today's configuration for yesterday's dispatch."*
- **UI: none.**

### `dispatch.overrideRequest` — mutation · permission `dispatch.override.request`
- **Roles**: dispatcher, office, management
- **Input** `{ checkId: int+, blockerCode: string(2..80), reason: string(10..600) }`
- **Behaviour** loads the check, finds the blocker **on that check** (`BAD_REQUEST` if the code is not on it), resolves the caller's ladder role, and **records the request whether or not it is permitted**. For a non-overridable blocker it stores `refusalReason: "This blocker is overridable by no one — the underlying condition must be fixed"`.
- **Output** `{ checkId, blockerCode, requestable: boolean, refusal: string|null, requiredAuthority }`
- **Key property**: *"A request against a non-overridable blocker is recorded and refused, not silently dropped."*

### `dispatch.overrideGrant` — mutation · permission `dispatch.override.grant` · **SENSITIVE**
- **Roles**: dispatcher, management
- **Input** `{ checkId, blockerCode, reason: string(10..600) }`
- **Refuses** `PRECONDITION_FAILED` with no prior request (*"a grant answers a request"*); **`FORBIDDEN` if the requester is the grantor** — four-eyes.
- **Decision** `requestOverride(blocker, {...})` (`_core/dispatchReadiness.ts:508`): refuses a non-overridable blocker for any role; refuses an empty reason; refuses a role below `blocker.overrideAuthority` on the ladder `driver 0 · dispatcher/mechanic/office 1 · manager 2 · administrator 3`.
- **Ladder mapping** (`dispatchRouter.ts:39`): controller→administrator, management→manager, dispatcher→dispatcher, mechanic|shop_lead→mechanic, office|safety|hr→office, else driver.
- **Sensitive**: an unrecordable audit **refuses the call**.

### `dispatch.award` — mutation · permission `dispatch.award` · **SENSITIVE**
- **Roles**: dispatcher, management
- **Input** `{ checkId, startsAt, endsAt, maxAgeMinutes?: int 1..240 = 30 }`
- **Refuses** `PRECONDITION_FAILED` when `check.postingId == null`: *"This check is for a direct job assignment — use `jobUnits.create` with its `eligibilityCheckId`"*. **This is the fork in the workflow and the UI must respect it.**
- **Recomputes** facts server-side — *"The facts are recomputed here, never accepted from the caller"* — asking the **same question including the route**, then calls `awardAssignment`.
- **`awardAssignment`** (`_core/dispatchTransaction.ts:72`), inside one transaction:
  1. `SELECT … FOR UPDATE` on the posting — serialised per posting;
  2. **idempotent replay** by `awardIdempotencyKey` over posting/role/operator/unit/trailer/actor → returns `replayed: true` rather than double-assigning;
  3. loads the check and refuses if `checkRow.operatorId !== input.operatorId`; a row with no fingerprint is *"treated as invalid, never as valid"*;
  4. `assessEligibilityValidity` — **fingerprint mismatch → `dependency_change`**, else **age > `maxAgeMinutes` → `age`**;
  5. **resource-booking overlap re-check inside the lock**, half-open (`startsAt < existing.endsAt && endsAt > existing.startsAt`), for operator, unit and trailer;
  6. `decideAward` (`_core/dispatchAward.ts:225`).
- **`decideAward` refusal order**: posting/bid state → validity → **every `blocking` blocker, unconditionally, before overrides are consulted** → `unknown`/`review` blockers unless a granted override covers them → a belt-and-braces refusal if a granted override names a non-overridable blocker → resource conflicts.

> **The load-bearing consequence for the UI**: `severity: "blocking"` is refused at award **regardless of the `overridable` flag**. Two blocking blockers in the codebase carry `overridable: true` (`route_approval_stale|revoked|superseded`, `lone_worker_no_satellite`) and **their override can be requested and granted but will never permit an award**. See **K-2**.

### `dispatch.whatAmIMissing` — query · permission `dispatch.readiness_own` (universal)
- Reads `ctx.user.id` and **nobody else's**: resolves the caller's own `operators` row and returns `asChecklist(...)`. If no operator record is linked, returns `{verdict:"unknown", items:[], note:"No operator record is linked to your user"}`.
- **Not a dispatcher procedure** — it belongs to phase 6 (Driver Web), listed here because it shares the composer.

### `dispatch.enforcementGet` / `dispatch.enforcementSet`
- `enforcementGet` — query, `dispatch.read`; returns `{ mode: "off"|"advisory"|"enforced", source: "entity"|"global"|"default" }`.
- `enforcementSet` — mutation, `dispatch.enforcement.manage`, **SENSITIVE**, **management + controller only — not dispatcher**. Append-only: *"The history of when enforcement was on is audit trail."*
- **The dispatcher UI must display the current mode and must not offer to change it.**

## A.2 The assignment path — `jobUnits.create`

**This is the second, non-posting award route and it is easy to miss.**

| | |
|---|---|
| tRPC path | `fieldRoute.identity.jobUnits.create` |
| Procedure name | `jobUnits.create` → permission **`dispatch.assign`** |
| Roles | **dispatcher, management** |
| Service | `createJobUnitGated` (`server/dispatchEnforcementService.ts:30`) |

Behaviour by enforcement mode — *"Off: as always. Advisory: assign and report findings. Enforced:
assign only on a valid check — facts recomputed here, never trusted from the caller."*

It validates that a supplied `eligibilityCheckId` belongs to the same job and unit (`BAD_REQUEST`
otherwise), loads granted overrides, recomputes facts when `mode !== "off"`, and on success marks
the check `usedForAward: true`.

`fieldRoute.identity.jobUnits.list` — `dispatch.read`.

## A.3 Supporting reads the dispatcher needs

| tRPC path | Permission | Roles | Use |
|---|---|---|---|
| `fieldRoute.jobs.list` / `.byCode` | `job.read` | 9 roles | job context |
| `fieldRoute.identity.units.list` | `fleet.read` | 8 roles | unit picker |
| `fieldRoute.identity.operators.list` | `personnel.read` | dispatcher, office, management, hr, payroll_admin | driver picker |
| `fieldRoute.trips.list` / `tripStops.list` | `trip.read` | 9 roles | route context |
| `fieldRoute.identity.documents.list` | `compliance.read` | 9 roles | credential evidence |
| `fieldRoute.identity.inspections.list` | `inspection.read` | 8 roles | inspection evidence |
| `surfaces.exceptions` | `surface.exceptions.read` | 14 roles | board urgency feed |
| `surfaces.myDay`, `surfaces.inbox` | own-scoped | all | shell context |
| `readiness.forShift` / `.forTime` | `readiness.read` | 7 roles | shift view |

**Nothing above is UI-reachable today.**

---

# B. The dispatcher workflow

```
Dispatcher Board
   surfaces.exceptions (critical first) + fieldRoute.identity.jobUnits.list + fieldRoute.jobs.list
        │
        ▼
Open a dispatch
   fieldRoute.jobs.byCode + units.list + operators.list + trips/tripStops.list
        │
        ▼
Assign driver / unit / trailer          ← local selection only; nothing is written yet
        │
        ▼
Evaluate readiness           dispatch.readiness   (preview — writes nothing)
        │
        ▼
Record the check             dispatch.evaluate    (writes dispatchEligibilityChecks; returns checkId + fingerprint)
        │
        ├── verdict "eligible"        → award path
        ├── verdict "eligible_review" → review blockers must be covered
        ├── verdict "unknown"         → unknown blockers must be covered
        └── verdict "blocked"         → NO AWARD PATH EXISTS. Fix the condition.
        │
        ▼
Inspect a blocker            capability drill-down (§D); evidence read with the caller's own permissions
        │
        ▼
Correct what the caller may correct     ← only within the caller's authority (§E)
        │
        ▼
Request an override          dispatch.overrideRequest   (recorded even when refused)
        │
        ▼
A DIFFERENT authorised user grants      dispatch.overrideGrant  (four-eyes; never the requester)
        │
        ▼
Re-evaluate                  dispatch.evaluate again — a new checkId
        │
        ▼
Award
   posting  → dispatch.award(checkId, startsAt, endsAt)
   direct   → fieldRoute.identity.jobUnits.create(..., eligibilityCheckId)
        │
        ▼
Server recomputes facts · fingerprint compare · age check · overlap re-check in the lock
        │
        ├── refused → show every refusal verbatim; offer re-evaluate
        └── awarded → show result (and `replayed: true` where returned)
        │
        ▼
History      dispatchEligibilityChecks · dispatchOverrides · dispatchAuditEvents
```

### Prohibited by design

- **No "force ready" control.** No mechanism exists to mark readiness as passed; the client cannot construct one.
- **No client-side verdict.** The client renders what the server returned. It never derives a verdict from blockers.
- **No award on a `blocked` verdict.** The award button is not "disabled" — for a blocked check the award path is **not rendered at all**, because an override cannot help.
- **No enforcement-mode control.** Display only.

---

# C. Readiness visualization

## C.1 Two distinct vocabularies — do not merge them

| Vocabulary | Values | Source |
|---|---|---|
| **Eligibility verdict** (overall) | `eligible` · `eligible_review` · `blocked` · `unknown` | `deriveVerdict` — blocking > unknown > review > none |
| **Capability status** (per capability, P8.1) | `PASS` · `REVIEW` · `BLOCKED` · `UNKNOWN` · `NOT_EVALUATED` | `capabilitiesJson` on the check |

The engine's own rule: *"Unknown outranks review: an unevaluated condition is not a known-minor one."*

## C.2 Presentation contract

| Server value | Label | Treatment |
|---|---|---|
| `eligible` | **Ready** | the only state presented as ready |
| `eligible_review` | **Ready with review items** | never "ready" alone |
| `unknown` | **Not established** | **never green**; it is not a mild state |
| `blocked` | **Blocked** | no award path rendered |
| `PASS` | Pass | |
| `REVIEW` | Review | |
| `BLOCKED` | Blocked | |
| `UNKNOWN` | Unknown | **must not render like PASS** |
| `NOT_EVALUATED` | Not evaluated — *&lt;reason&gt;* | reason is carried; show it |

**Hard rule**: a colour, badge or icon must never reinterpret a server result. The mapping is a pure
function of the server string, defined once, and covered by an exhaustive `switch` with no `default`
arm that silently passes — the pattern `widgetPromotion.test.ts` already enforces elsewhere.

## C.3 Per-blocker presentation

From `DispatchBlocker`: `code`, `label`, `severity`, `subject` (operator/truck/trailer/job/route),
`overridable`, `overrideAuthority`.

Reuse `asChecklist()` (`readinessComposer.ts:637`) for `fixable` text rather than re-deriving it:

- non-overridable → **"Must be resolved — no override"**
- overridable + unknown → "Needs verification, or a *&lt;authority&gt;* override with a reason"
- overridable + review → "Resolve, or a *&lt;authority&gt;* may override with a reason"

**Plus one addition this spec requires** (see **K-2**): a blocker with `severity: "blocking"` shows
**"Must be resolved — an override cannot permit this award"** *even when `overridable` is true*,
because `decideAward` refuses it before overrides are read.

## C.4 Stale / fact-changed

`assessEligibilityValidity` returns `invalidatedBy: "dependency_change" | "age" | "none"`. Present
them differently — *"the facts moved"* and *"this is old"* are different problems — using the
server's own `reason` string. A stale check offers **re-evaluate**, never award.

## C.5 Policy provenance

`automationPolicyJson` carries a `PolicySnapshot[]`: entitlement state and reference, requested mode
by scope, resolved mode, ceiling applied, clamped flag, trace (`"tenant=HYBRID → role=AUTO →
resolved=HYBRID"`) and reason. Display it read-only in the drill-down.

> **Note for the reviewer**: `SAFETY_CEILINGS` is `{}` and the automation mode has no operational
> consumer. Present the snapshot as provenance, **not** as something that influenced the decision.

---

# D. Capability drill-down

Eight capabilities (`_core/readinessCapabilities.ts:32-41`). Five are required always; routing,
destination acceptance and mechanic release are trip-conditional (`dispatchContractFor`).

| Capability | Blocker codes | Evidence | Dispatcher can | Needs another role | Needs external |
|---|---|---|---|---|---|
| **operator qualification** | `operator_licence_missing/_expired/_unknown`, `medical_fitness_not_current/_unknown`, `academy_*`, `academy_review_*`, `availability_not_declared`, `field_device_revoked` | `documents.list` (`compliance.read` ✔), `academy` reads | view; chase | **`compliance.write`/`review` = safety, office, management.** Medical reaches dispatch as *"eligible"* and nothing more | — |
| **unit inspection** | `truck_inspection_*`, `trailer_inspection_*`, `trailer_incompatible`, `maintenance_overdue`, `fault_*`, `measurement_device_uncalibrated` | `inspections.list` ✔, `documents.list` ✔ | view | `inspection.write` = driver, mechanic, shop_lead, safety | — |
| **operating documents** | `truck_registration_*`, `truck_insurance_*`, `insurance_coverage_expired`, **`insurance_coverage_unknown`** (blocking, non-overridable — the one place UNKNOWN is promoted to BLOCKED on purpose), `insurance_proof_missing`, `permit_missing/_unknown` | `documents.list` ✔ | view | office / management | — |
| **mechanic release** | `critical_defect`, `mechanic_release_missing` — both blocking, non-overridable | `fieldRoute.workOrders.list` | **view only** | **mechanic / shop_lead only.** The dispatcher must not gain resolution authority | **DEPENDS ON PR #4** |
| **hos** | `hos_insufficient` (blocking, non-overridable), `hos_attested` (review, dispatcher), `hos_unknown` (unknown, manager) | `hosAttestations`, `dutyRecords` | may override `hos_attested` (review) | attestation needs the person who reviewed the log | cycle engine absent (phase 7) |
| **route restrictions** | `route_blocked`, `route_not_evaluated`, `route_review`, `route_data_unverified`, `route_approval_stale/revoked/superseded` (**blocking + overridable — see K-2**), `communication_*`, `lone_worker_no_satellite` (**same**) | `routeApprovals`, comm plan | request manager override on `route_not_evaluated`/`route_review` | manager grants | live feeds absent (phase 9) |
| **destination acceptance** | `destination_not_accepting` (blocking, non-overridable; names facility and reason codes), `destination_acceptance_unverified` (review, manager) | `loadFacilityAssessments` | view; request manager override on unverified | facility assessment | — |
| **enforcement orders** | `oos.driver`, `oos.vehicle`, `oos.trailer`, `oos.cargo`, `oos.carrier` — blocking, **non-overridable by anyone** | `outOfServiceOrders` | **nothing.** *"A manager may override a company rule; an inspector's order is not a company rule"* | nobody in the company | **currently reports PASS — phase 0** |

### ⚠ Two capability-level warnings for the implementer

**D-1 — enforcement currently lies.** On `main`, `composeReadiness` raises enforcement blockers only
when the caller passes `subject.enforcement`, and **no production caller does**. `dispatch.readiness`
and `dispatch.evaluate` do not pass it. So **the enforcement capability will render `PASS` with an
active out-of-service order in the database.** Build the panel to render `BLOCKED` correctly; expect
it to show `PASS` until phase 0 lands. **Do not compensate in the client.**

**D-2 — blocker→capability attribution is regex-based and imperfect.** `capabilityOf`
(`readinessCapabilities.ts:152`) matches the blocker code. `roadside_event_open` matches `/road/` and
lands under **route restrictions** though its subject is the truck; `classification_incomplete`,
`documents_missing`, `tdg_document_missing` and `erp_missing` match nothing and fall back to the job
subject's first capability, **destination acceptance**. The fallback is deliberate (*"losing a
blocker here would be the worst possible failure"*). **Always show the blocker's own `subject` and
`label` alongside its capability grouping**, so a misgrouped blocker is still legible.

---

# E. Role boundaries

| Action | Permission | Roles |
|---|---|---|
| View readiness | `dispatch.read` | dispatcher, office, management, auditor |
| Record a check | `dispatch.evaluate` | dispatcher, **safety**, office, management |
| Request override | `dispatch.override.request` | dispatcher, office, management |
| **Grant override** | `dispatch.override.grant` **SENS** | **dispatcher, management** |
| **Award (posting)** | `dispatch.award` **SENS** | **dispatcher, management** |
| **Assign (direct)** | `dispatch.assign` | **dispatcher, management** |
| Set enforcement mode | `dispatch.enforcement.manage` **SENS** | **management, controller — not dispatcher** |
| Resolve a critical defect | `maintenance.record_release` | **mechanic, shop_lead** |
| Revoke a release | `maintenance.revoke_release` | shop_lead, management |
| Verify a compliance document | `compliance.review` **SENS** | safety, office, management |
| Create/attest HOS | `hos.*` | the reviewing person |
| Lift an OOS order | — | **nobody in the company** |

### The rule

> The dispatcher UI **may display** problems outside dispatcher authority. It must **never acquire a
> permission because a screen needs to show something.**

Worked example, exactly as the brief states it: a critical maintenance defect blocks readiness. The
dispatcher sees **"Blocked — unresolved critical defect on Unit 142"**, the defect's title and
reported date, and *who can act* ("a mechanic or shop lead must record a release"). The dispatcher
does **not** get a resolve action, and the client does not call a `maintenance.*` mutation.

### Two scope facts that will bite

- **Branch-scoped grants confer nothing here.** `roleProcedure` calls `authorize()` without `resourceBranch`, so `authorize` keeps only grants with `scopeRef IS NULL` (`recordsAuthorization.ts:2009-2016`). A branch-scoped dispatcher is refused with *"Roles are confined to a branch and this operation did not resolve the resource's branch — a global grant is required here."* **Verified by execution.** The UI must render that refusal, not treat it as a bug.
- **Four-eyes on override.** `overrideGrant` returns `FORBIDDEN` when requester and grantor are the same user. A single dispatcher cannot self-serve; the UI must make the two-person flow legible rather than looking broken.

---

# F. Screens

Four screens. No showcase panels. Every panel either reads records or renders an explicit empty
state naming why — `panelSource.ts` already provides `fromQuery()` and `demonstration()`, and this
slice uses **`fromQuery()` only**.

### F.1 Dispatcher Board — `/dispatch`
Active jobs and assignments, each row: job code · driver · unit · location · posting/assignment state
· last readiness verdict if a check exists · urgent blockers.
Reads: `surfaces.exceptions` (critical first) · `fieldRoute.identity.jobUnits.list` ·
`fieldRoute.jobs.list` · `dispatch.enforcementGet` (mode banner, read-only).
**Empty state**: *"No active dispatches on this database"* — never fabricated rows.

### F.2 Dispatch Detail — `/dispatch/:jobId`
Job, client, location; driver / unit / trailer selection; route context; readiness capability list;
evidence links; history.
Reads: `jobs.byCode` · `units.list` · `operators.list` · `trips.list` · `tripStops.list`.
**Contacts**: there is **no contact table in LeaseOS**. Render job/client fields that exist and
nothing more. Do not invent a contacts panel.

### F.3 Readiness Panel *(component, used in F.2)*
Overall verdict · eight capabilities with P8.1 status · blockers grouped by capability but each
showing its own `subject` and `label` (**D-2**) · `contributions` (the per-engine findings the server
already returns) · policy provenance · re-evaluate.

### F.4 Override Workflow *(modal from F.3)*
Rendered **only** for a blocker where `overridable === true` **and** `severity !== "blocking"`
(**K-2**). Shows the required authority, a mandatory reason (min 10 chars — server-enforced), and the
request/grant split with the four-eyes rule stated.
For a non-overridable blocker the modal does not open; the row reads *"Must be resolved — no override"*.

### F.5 Award Confirmation *(modal from F.2)*
Restates the check, its age against the 30-minute window, and the fingerprint. Fork by
`check.postingId`: **posting** → `dispatch.award`; **direct job** → `jobUnits.create` with
`eligibilityCheckId`. A server refusal lists **every** refusal string verbatim and offers
re-evaluate. `replayed: true` is shown as *"already recorded"*, not as a new award.

**No award path is rendered for a `blocked` check.**

---

# G. Live updates

**Finding**: the router contains **245 queries and 445 mutations — and zero subscriptions**. There is
no WebSocket link, no SSE endpoint, no observable transport in the client (`showcaseGuard.ts` uses
`observable` for a tRPC link, not for live data).

**There is a proven pattern already in production**: `client/src/portal/PortalShell.tsx:42-44` uses
TanStack Query with `refetchInterval: 60_000`.

**Recommendation — use it. Do not add WebSockets.**

| Surface | Mechanism |
|---|---|
| Board | `refetchInterval: 60_000` |
| Dispatch detail | `refetchInterval: 60_000` |
| Readiness panel | **on demand only** — readiness is a point-in-time judgement and background re-evaluation would write `dispatchEligibilityChecks` rows nobody asked for |
| After any mutation | `invalidateQueries` on the affected keys |
| Award | no polling — the server recomputes at award; that is the freshness guarantee |

Adding a subscription transport would mean a new tRPC link, a WebSocket server, and a reconnection
story, for a screen whose authoritative moment is already protected by the fingerprint.

---

# H. Responsive behaviour

Web dispatcher interface. Responsive, **not** the Native Field Mobile project.

| Width | Layout |
|---|---|
| Desktop ≥1280 | board + detail side by side |
| Tablet 768–1279 | stacked; readiness panel full width |
| Phone browser <768 | one column; board rows collapse to a card with verdict and top blocker |

Native device APIs are **out of scope**. No camera, GPS, biometrics or offline persistence in this
slice. Tailwind breakpoints and the existing Radix components already in `components/ui`.

---

# I. Tests to write before implementation

DOM tests use the existing `jsdom` setup (8 `.dom.test.tsx` files exist). Integration tests call
**real production procedures** against a real MariaDB, following `dispatchGate.test.ts`.
**No client test may reproduce server readiness logic.**

| # | Test | Kind | Asserts |
|---|---|---|---|
| 1 | dispatcher sees assigned work | DB | `jobUnits.list` + `jobs.list` render real rows; empty DB → explicit empty state |
| 2 | readiness renders the real backend result | DB+DOM | the rendered verdict equals `dispatch.readiness`'s `verdict` string; no client derivation |
| 3 | PASS presented as ready | DOM | only `eligible` renders "Ready" |
| 4 | REVIEW stays review | DOM | `eligible_review` never renders as ready |
| 5 | **BLOCKED prevents award** | DB | award path not rendered; a forced `dispatch.award` call is refused by the server |
| 6 | **UNKNOWN does not become PASS** | DOM | `unknown` verdict and `UNKNOWN` capability both render non-ready |
| 7 | **NOT_EVALUATED does not become PASS** | DOM | renders "Not evaluated" with the reason; never green |
| 8 | non-overridable blocker has no usable override action | DOM+DB | no modal; a forced `overrideRequest` returns `requestable: false` with the refusal, and the row is still recorded |
| 9 | authorised overridable blocker enters the flow | DB | request then grant by a **different** user succeeds |
| 10 | unauthorised user cannot grant | DB | a driver/office caller is refused; requester-as-grantor gets `FORBIDDEN` |
| 11 | **client manipulation cannot change readiness** | DB | mutating the client's cached blockers then awarding is refused by the server |
| 12 | **fact change between evaluate and award refuses** | DB | evaluate → insert a critical defect → award → refused with `dependency_change`; and age > `maxAgeMinutes` → refused with `age` |
| 13 | tenant boundaries hold | DB | a cross-tenant job/unit is `NOT_FOUND`, never `FORBIDDEN` |
| 14 | **API failure displays failure, not ready** | DOM | a rejected query renders an error state; it must be impossible to reach "Ready" from an error |
| 15 | empty response → explicit empty state | DOM | `fromQuery()` empty path, never fabricated rows |
| 16 | four-eyes enforced end to end | DB | full request→grant→re-evaluate→award chain with two users |
| 17 | direct-job check cannot use `dispatch.award` | DB | `postingId == null` → `PRECONDITION_FAILED` naming `jobUnits.create` |
| 18 | idempotent replay is not a second award | DB | identical award twice → `replayed: true`, one assignment |
| 19 | overlap conflict refuses inside the lock | DB | a second booking overlapping the same operator/unit is refused |
| 20 | branch-scoped dispatcher is refused legibly | DB | branch grant → refusal message rendered, not swallowed |

Tests 5, 6, 7, 11, 12 and 14 are the safety core. **A failure in any of them is a release blocker.**

---

# J. PR #4 dependencies

PR #4 is written and green; this spec does not duplicate it.

| Behaviour | On `main` today | After PR #4 | Mark |
|---|---|---|---|
| Critical defect + unrelated/failed/revoked release | readiness reports **PASS** and the unit is awardable | stays **BLOCKED** | **DEPENDS ON PR #4** |
| Revoking a release | readiness gets **better** | gets worse or stays the same, never better | **DEPENDS ON PR #4** |
| Defect resolution | impossible — no write path exists | `records.maintenance.resolveDefect` (mechanic, shop_lead) | **DEPENDS ON PR #4** |
| `mechanic release` capability | can show PASS with an unresolved critical defect | truthful | **DEPENDS ON PR #4** |
| Everything else in this spec | unchanged | unchanged | — |

**Guidance**: build the mechanic-release drill-down against the **post-PR #4** contract — a release
is evidence only when it names the defect, is not a revocation, did not fail its test and has not
been withdrawn. **Do not design around the timestamp behaviour**, and do not add client-side
compensation. Until PR #4 merges, this one capability may display an incorrect PASS, and that is the
correct thing for it to do given the server's answer.

---

# K. Genuinely missing backend

Four items. **None is implemented here.** Each states why existing procedures cannot cover it.

### K-1 — A dispatcher-scoped board read
- **Why existing procedures cannot**: `dispatch.readiness` takes ids and loads facts; it does not call `actingScopeFor`, and there is no procedure returning *"the dispatches this caller is responsible for, with their latest check"*. `surfaces.exceptions` is exception-shaped, `jobUnits.list` is scope-filtered but carries no readiness. Composing client-side would mean N+1 calls and a client-assembled view of a safety state.
- **Proposed interface**: `dispatch.board({ limit? }) → { jobId, jobCode, postingId|null, operatorId, unitId, trailerId, latestCheck: { checkId, verdict, evaluatedAt, blockerCount, stale } | null, enforcementMode }[]`, query, permission **`dispatch.read`** (existing), scoped through `actingScopeFor` + `ownershipScopeWhere`.
- **Safety**: read-only; returns the **stored** verdict and never recomputes, so the board cannot become a second readiness engine. Must not widen `dispatch.read`.

### K-2 — Reconcile `blocking` + `overridable: true`
- **The contradiction**: `route_approval_stale|revoked|superseded` (`readinessComposer.ts:481`) and `lone_worker_no_satellite` (`_core/commRoute.ts:974`) are `severity: "blocking"` with `overridable: true` and a manager authority. `overrideRequest` accepts them, `overrideGrant` grants them, and `decideAward` refuses the award anyway because it rejects every blocking blocker before reading overrides.
- **Why the UI cannot fix it**: the client would have to encode the award gate's precedence, which is exactly the duplication this codebase forbids. Silently hiding the override would also hide a real inconsistency.
- **Proposed interfaces** (owner decision, not a code choice): either **(a)** correct the two blockers to `overridable: false`, or **(b)** have `decideAward` consult granted overrides for blocking blockers that declare themselves overridable. **(a)** is smaller and safer; **(b)** changes the meaning of "blocking".
- **Until decided**: the UI applies §C.3 — a blocking blocker reads *"an override cannot permit this award"* regardless of the flag.
- **Not in scope for this slice.** Listed so it is not mistaken for a UI bug. *(This is the static finding X-9 from the audit — never execution-verified.)*

### K-3 — Blocker→evidence deep links
- **Why existing procedures cannot**: blockers carry `code`, `label`, `subject` — not the id of the record that caused them. A dispatcher seeing `truck_inspection_expired` has no link to the document. `surfaces.chain` walks an evidence chain from a known anchor; there is no blocker→anchor map.
- **Proposed interface**: extend `DispatchBlocker` with an optional `evidenceRef?: { table: string; id: number }`, populated where the composer already holds the row. Additive and backward compatible.
- **Safety**: the ref is a pointer, not content. The evidence read still goes through the caller's own permission (`compliance.read`, `inspection.read`), so a dispatcher who may not see a document still cannot.
- **Workaround for v1**: link to the filtered list screen for that subject. Ships without K-3.

### K-4 — Override history on a check
- **Why existing procedures cannot**: `dispatchOverrides` rows are written by `overrideRequest`/`overrideGrant` and **read only inside `award`**. No procedure returns them, so the UI cannot show *"requested by A, granted by B, reason …"* — and a refused request, which the system deliberately records, is invisible.
- **Proposed interface**: `dispatch.overrideHistory({ checkId }) → { blockerCode, requestedByUserId, requestedByRole, reason, granted, refusalReason, requestedAt }[]`, query, permission `dispatch.read`.
- **Safety**: read-only; contains reasons written by staff — treat as internal, not portal-visible.
- **Workaround for v1**: show only the outcome of the grant call in-session. Ships without K-4, degraded.

**Everything else in this slice is wiring.**

---

# L. Definition of done — Dispatcher Slice v1

- [ ] No showcase or mock data anywhere in the operational path. Every panel uses `fromQuery()`; empty means an explicit empty state.
- [ ] `dispatch.readiness`, `evaluate`, `overrideRequest`, `overrideGrant`, `award`, `enforcementGet` and `jobUnits.create` are all wired to real UI.
- [ ] Readiness is server-authoritative: no verdict, status or colour is computed client-side from blockers.
- [ ] Role boundaries preserved — no `maintenance.*`, `compliance.write` or `dispatch.enforcement.manage` call from this UI.
- [ ] The award gate cannot be bypassed: no award path on a `blocked` check; no client-supplied facts; server refusals surfaced verbatim.
- [ ] Failure and unknown states fail safe — an API error, an `unknown` verdict and a `NOT_EVALUATED` capability all render non-ready.
- [ ] Real DB-backed integration tests calling production procedures, plus DOM tests for presentation. Tests 5, 6, 7, 11, 12, 14 pass.
- [ ] Tenant isolation verified: cross-tenant subjects return NOT_FOUND.
- [ ] Usable at desktop, tablet and phone-browser widths.
- [ ] `scripts/ci-gate.sh` == PASS, including gates 7b, 7c and 8; `LEASEOS_CURRENT_STATE.md` regenerated.
- [ ] `crossLayerIntegrity.test.ts` router-surface pin updated **only** if K-1/K-4 were built.
- [ ] Mechanic-release drill-down written against the post-PR #4 contract.

---

# Recommended first implementation task

> **Build the Readiness Panel (F.3) against `dispatch.readiness`, behind a `/dispatch/:jobId` route,
> with tests 2, 3, 4, 6, 7, 14 and 15 written first.**

Why this first:

- It is the **smallest thing that proves the whole slice**: one read-only query, no writes, no state machine, no permission escalation.
- It is where **every safety rule in this spec lives**. If the status mapping is right here, the rest of the slice inherits it.
- It needs **no new backend** — not even K-1, since the route supplies the ids.
- It is **read-only**, so a mistake cannot write a bad `dispatchEligibilityChecks` row or a bad award.
- It makes phase 0's value visible: the enforcement capability will read `PASS` today and `BLOCKED` after the fix, on the same screen, with no client change.

Do **not** start with the board — it wants K-1, and a board without a readiness panel shows a verdict
nobody can explain.
