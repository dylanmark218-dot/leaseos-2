# Phase 1 spine — what sits on one driver, one job, end to end

Against `9e1a75f82`. **A proposal, no code.** The moratorium stands: no new engines until this path
is wired.

The spine is: a driver is dispatched, drives to a site, loads, hauls, disposes, returns, and the job
closes as a clean record. Below, each of the 55 declared-unwired engines is placed on that path or
off it.

## On the spine — 13 engines

| Engine | Where it sits | What connects it |
|---|---|---|
| `dispatchMatching` | dispatch | the audit names it as duplicating the dispatch surface's own path — **resolve the duplication before wiring, not after** |
| `openShifts` | dispatch | same shape: duplicates inline router eligibility |
| `complianceDocumentValidity` | dispatch gate | the `documentExpiry` tile decides expiry inline; this is the intended single answer |
| `jurisdiction` | dispatch gate, routing | callers carry their own logic today |
| `routeApprovalPolicy` | route approval | landed unwired at v23.19 |
| `sourcePrecedence` | routing | same |
| `truckRoutingAdapter` | routing | has no live feed — blocked on the routing source decision, not on wiring |
| `preDepartureCache` | departure | the offline package's own loader |
| `offlineCapability` | field runtime | **not called by the device runtime** — this is the seam HS1 covers |
| `phoneLocationGate` | field capture | landed unwired at v23.19 |
| `siteBaseline` | stop timing | needs per-boundary confirmation first (below) |
| `fieldTicket` | job close | the audit names an older router path doing the same job |
| `tripPassportPackage` | job close | needs `tripPassportPackages` tables |

## Adjacent, wire only where the one-job path reaches them — 6

`billing`, `tripBillingProjection` (blocked on the pricing-authority decision), `billingAdjustment`,
`disposalReconciliation`, `loadSenseMaterialMovement`, `safetyBinder`.

## Off the spine — 36

The OSM loader (`osmImport`, `osmTopology`, `osmLoadPlan`, `osmLoad`) builds from scripts. The widget
family (`widgetRegistryV2`, `widgetSemantics`, `widgetSourceContract`, `widgetProjection`,
`boardSemantics`, `dashboardWidget`, `deviceManifest`) is the B28 port. The feed family
(`feedCollector`, `feedHttp`, `feedIngest`, `feedScheduler`, `advisoryImpact`) is not started.
`knowledge/*` is a half-wired subsystem. The rest — `map`, `demoDataset`, `migrationLedger`,
`imageGeneration`, `voiceTranscription`, `modelGateway`, `heartbeat`, `dataApi`, `dataIngestion`,
`domainEmitters`, `eventEmitter`, `financialCalendar`, `hosClockPresentation`, `monitoringNotice`,
`remoteWorkEvidence`, `tracking`, `loadSenseEvents`, `sourcePrecedence` overlap aside — are either
script-only, superseded, or belong to later phases.

## The ordering the dependencies force

1. **Per-boundary confirmation on `tripStops`.** `0169` gave the row an actor; it did not say which
   of the five timestamps a person stands behind. `siteBaseline` filters on exactly that and cannot
   be wired to real data without it. One resolver, read by both engines.
2. **Resolve the four duplications before wiring any of them.** `dispatchMatching`, `openShifts`,
   `complianceDocumentValidity`, `fieldTicket` each have a live inline implementation answering the
   same question. Wiring the engine beside the inline copy produces two answers; deleting the inline
   copy is the actual work, and it is the highest-value item on this list because every one of them
   is a decision someone is already relying on.
3. **`offlineCapability` → HS1.** It is the device seam and the hybrid plan already covers it.
4. **Then the rest of the spine**, in path order: dispatch gate → routing → departure → capture →
   stop timing → job close.

Nothing above needs a new engine. Every item is either a deletion, a resolver, or a router over
something already written — which is the point of the moratorium.

---

# Decisions recorded

## Sync states — SIX, confirmed against the code

`client/src/runtime/contracts.ts:22` already ships exactly the six:
`saved_locally | queued | syncing | synchronized | failed | conflict`. No change needed.

`rejected` is a reason under `failed`. Note it also already exists as a `LocalPackage.state` value
at package granularity, which is a different axis and stays.

**`in_doubt` is not `NOT_EVALUATED`, and the correction is right.** I had suggested folding them.
`NOT_EVALUATED` means a capability that was never asked — a disabled module, an unlicensed feature —
and carries a required reason from `module_disabled | not_licensed | not_applicable |
no_data_source_loaded`. None of those describes a command that was sent and never acknowledged.
Folding them is the "missing ≠ expired" collapse the rules forbid, one level up. **Sent-but-unacked
is a `syncing` sub-state resolved by idempotent retry**, which is what the HS3 ledger's
`commandId` unique index is for.

## Automation safety floor — six of eight map, three do not

The mechanism is already built and declares itself waiting for this: `automationPolicy.ts:70` —
*"The per-capability maximum. P8.2 supplies the mechanism; **P8.4 decides the list**"* — with
`ceiling: null` documented as "no ceiling, not 'assume MANUAL'". Your floor is P8.4.

| Your capability | Code key | |
|---|---|---|
| HOS | `CAPABILITY.hos` | exact |
| Vehicle safety | `CAPABILITY.unitInspection` | closest existing |
| Mechanic release | `CAPABILITY.mechanicRelease` | exact |
| Route legality | `CAPABILITY.routeRestrictions` | exact |
| Customer acceptance | `BILLING_CAPABILITY.customerAcceptance` | exact |
| Invoice validity | `BILLING_CAPABILITY.acceptedLines` | **approximate — not the same claim** |
| **TDG** | — | **no capability key exists** |
| **Permit validity** | — | **no key, and no permits table at all** |

Six can be capped today. Three cannot, and inventing keys for them would put a ceiling on a
capability nothing evaluates — a floor that reads as enforced and enforces nothing, which is worse
than an absent one. **Recommendation: cap the six now, and record TDG and permit validity as
capabilities that do not exist yet rather than as capped.** Permits are the audit's §2.1: the gate
is written and three-valued, and `readinessComposer.ts:401` hardcodes `permitRequired: false`, so
today it never runs at all.

## Product name — LeaseOS. Not a blocker.

---

# Proposed defaults — awaiting confirmation

### Service codes: `commercialSetupProfiles.servicesJson`

The live pricing stack already resolves per `financialEntityId` + `serviceCode` + `rateKind` against
`chargeDefinitions`. A per-customer column would be a second place a service code can live, and the
two would disagree the first time a customer was set up twice. `servicesJson` sits beside the setup
that already defines them.

### Baseline window: all history, with the router passing a window it names

`buildSiteBaseline` deliberately does not filter by age, and its header gives the reason: at a site
visited twice a year, eighteen-month-old measurements are all there is. A trailing default hidden in
the engine would silently unmeasure exactly the sparse sites `MINIMUM_SAMPLES` protects. If a window
is wanted, the router passes it and the notice says which window produced the count — a baseline
whose window is invisible cannot be argued with.

### Binder requirement set: seeded per jurisdiction, unverified until checked

Same shape as the HOS profiles, and for the same reason — a requirement list is a claim about the
law. Seed it, mark every row unverified, and let `applicability_unknown` count in the denominator
until a person verifies it. That is P9 work, and the binder already treats an unanswered
applicability question as required rather than excluded.

---

# Blocked

**The knowledge-index reconciliation cannot start.** `docs/CONTEXT_IMPORT_2026-09-20.md` does not
exist in the repo. The only knowledge material present is `docs/knowledge/` — `INDEX.md`,
`README.md`, `COVERAGE_AUDIT.md`, `FINDINGS.md` and the 15 source documents — filed earlier from the
export tarball. There is no import record naming which of the ~190 were deliberately excluded and
why, so there is nothing to reconcile the index against. If that zip exists, it has not been dropped
in.
