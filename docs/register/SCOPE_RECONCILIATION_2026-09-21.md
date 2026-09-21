# Scope reconciliation — nine proposed items against the tree

Written against `d61baaf9c`. **Nothing here is built.** This is the reconciliation asked for before
any of it is coded, because several pieces already exist under other names — the thing that produced
a second `resolveRate` and a second `osmLoad` when nobody checked first.

Status: `BUILT` · `PARTIAL` · `SPEC` (specified, no code) · `MISSING` (not specified either).

---

## 1. Unified contact + job directory — **MISSING**

Three tables touch people on a job: `crews`, `crewMembers`, `jobCrewAssignments`. They assign known
workers to work; they are not a directory.

Everything else is a field on whatever record needed it:

| Column | Table |
|---|---|
| `emergencyContact` | `operators` |
| `emergencyContacts` (TEXT) | `unitSafetyPlans` |
| `contactJson` | `applicants` |
| `contactName` / `contactPhone` / `contactEmail` | `facilities` |
| `billingContact`, `salesContact`, `underwriterContact` | commercial/insurance tables |

No contact entity, no next-of-kin, no muster points, no ERAP or 911 directory, no medics, no
role/category/verification/effective-dating, no job contact package.

**The relationship-not-copy design is already precedented here.** `manifestPartySnapshots` holds the
parties as they stood when the manifest mattered, beside live references — exactly the pattern
proposed, working, in one subsystem. Build the directory against that precedent rather than a new
convention.

## 2. Emergency operations — **PARTIAL, and only after the event**

Built: `incidentReports`, `incidentActions`, `incidentPeople`, `incidentMatters`,
`incidentNotificationObligations`, plus `_core/escalation.ts` and `unitSafetyPlans`.

That is the *response* half. The *preparation* half is absent: no muster points, no ERP record per
job or lease, no operational ERAP registration (the string appears only in training-topic coverage),
no medics, no worker check-in, no overdue/lost-contact escalation.

`unitSafetyPlans` holds `hazardSummary`, `shutdownProcedure`, `requiredPpe`, `sdsReferences` and
`emergencyContacts` — all `text`. So the content exists as prose nobody can query, dispatch cannot
gate on, and the offline package cannot itemise. The chain proposed — ERP → muster → nearest
resources → hazards → contacts → check-in → overdue → incident → evidence → reporting — has its last
three links built and its first five missing.

## 3. TDG classification engine — **PARTIAL**, and the coverage audit understates what exists

`loadProfiles` carries `unNumber`, `properShippingName`, `packingGroup`, **`sdsStorageKey` and
`sdsStorageUrl`**. So *"no SDS storage"* in `PROJECT_KNOWLEDGE_COVERAGE_AUDIT.md` §2.2 is wrong —
per-load SDS storage exists. What does not exist is an SDS *library* keyed by UN number, which is
the thing that makes it reusable.

Still genuinely absent: no UN reference set, so all three `unNumber` columns (`loadProfiles` and
`manifests` at `varchar(40)`, `incidentReports` at `varchar(20)`) accept any string and nothing
checks them against each other; no subsidiary class; no placard derivation (`placards` exists only
as a document-category enum value); no operational ERAP record.

**Already enforced, and worth keeping when the engine is built:** `loads.create`
(`server/routers.ts:1560`) declares `classificationStatus: REFUSED`, which rejects any caller-supplied
value with *"Trust-bearing value refused: this state is established by its own review, verification or
transition procedure, never by a create or capture."* So "the software must not invent regulatory
classifications" is not an aspiration here — the create path already refuses to accept one. The
engine has to reach the same status through review, not by writing it.

**One thing to look at, and it is not RB-01.** `sdsStorageUrl` is a caller-supplied string of up to
1,024 characters on that same create input, and nothing in production writes it — the only reference
in the tree is the Zod input. It is not a `/manus-storage/` path minted by `storagePut`, so it is not
the persisted bearer capability RB-01 describes. It is an unvalidated URL a client can store and
something downstream may later render or follow. Decide whether it should be a key like every other
stored object, or drop it in favour of `sdsStorageKey` beside it.

## 4. Physical-truck digital twin — **PARTIAL, and the furthest along of the nine**

Built, and substantial: `loadSenseAxleWeights`, `loadSenseWeightSnapshots`,
`loadSenseCalibrationModels`, `loadSenseGatewayBindings`, `loadSenseGatewayFrames`,
`loadSenseScaleReconciliations`, `measurementDevices`, `measurementDeviceAssignments`,
`calibrationEvents`, `calibrationSweeps`, `calibrationSweepFindings`, `fieldDevices`,
`deviceKeyEvents`, `deviceSafetyLatches`.

`telemetrySnapshots` already carries `odometerKm`, `engineHours`, **`ptoHours`**, `idleMinutes`,
`fuelLevelPct` — so PTO state, engine hours and fuel are in the tree, not missing.

Absent from the proposed list: tanker level/volume, product temperature, refrigeration
temperature/status, pressure/vacuum (the only `pressureKpa` is on `tireMeasurements`), trailer
identity as a telemetry subject, boiler/water temperature, door/hatch state, pump runtime.

**Extending the existing vocabulary is right and a new subsystem would be wrong**, for a reason the
tree already demonstrates: LoadSense carries measurement identity through calibration →
reconciliation → manifest → ticket → billing. A parallel sensor path would have to re-derive that
chain, and the second one would be the one nobody audits.

## 5. Journey management — **MISSING as an object, components BUILT**

`trips`, `tripStops`, `tripBreadcrumbs`, `routeRequests`, `routeApprovals`, `routeContexts`,
`routeDecisions`, `routeEvidenceEntries` all exist. There is no entity above the trip: nothing spans
dispatch → departure → travel → lease → disposal → return, and nothing carries check-in cadence,
road/radio dead-zone plan, fatigue, weather, wildlife or alternate-route state across those legs.

Book 26 is marked SPEC in the knowledge index and flagged there as trip-attached and worth
prioritising, which matches. The work is one new entity plus references, not a new subsystem — the
legs it would span are built.

## 6. Offline field package — **PARTIAL: carrier BUILT, contents incomplete**

`syncPackages`, `syncPackageItems`, `syncReceipts`, `syncConflicts`, `deviceSyncNonces`, plus
`communicationPackages` / `communicationPackageDownloads` with verified/unverified channel counts.
The carrier, its manifest, its hashes and its download receipts exist.

What is proposed is a *contents* question on an existing carrier, and most of the named items are
blocked on §1, §2 and §5 rather than on packaging: the job contact package needs contacts, the
emergency/muster block needs muster points, the radio plan exists (`communicationPackages`), the TDG
block needs §3. So this item should be sequenced last of the group, not first — it is the assembly
of things that must exist before they can be packed.

The test it should be built against is the one proposed: *if this tablet loses connectivity now, can
this driver finish or abort safely?* That is answerable as a package-completeness verdict in the
shape `tripPassportPackage` already uses — required / not-applicable / unresolved, with unknown
applicability outranking a missing item.

## 7. Scenario engine — **MISSING**

No table matches scenario, simulation or counterfactual. `projections` and `calendarProjection`
project forward from actuals; neither models an alternative world.

One design constraint worth fixing now: a scenario must not be able to produce an answer the live
path would refuse. The engines it would traverse (`dispatchReadiness`, `routeEvaluation`, `hos`,
`billing`) all have explicit UNKNOWN/REVIEW states, and a scenario that silently resolves one of
those to a concrete answer would be a second decision authority — the failure this codebase keeps
catching. A scenario should report the same verdict the real gate would, including its refusals.

## 8. Production release track — **MISSING as governance**

The underlying items are catalogued (`capacitor.ts` declares the native capabilities unimplemented;
the audit's RB-04 lists them; the register carries encrypted SQLite, keystore, camera evidence,
offline GPS, biometric signing, device tests). What does not exist is a track that is *separate from
feature work*, so "the gate is green" continues to mean "the server tests pass" and nothing prevents
that being read as shippable.

This is a register/process change rather than code, and it is the one item here that costs almost
nothing to do first.

## 9. Operational graph — **PARTIAL, and partly already true under another name**

The canonical-identity half is largely built. Reference columns are pervasive and consistent —
`tripNumber`, `ticketNumber`, `invoiceNumber`, `packageRef`, `manifestRef`, `decisionRef`,
`documentRef`, `evidenceRecordId` — and the `subjectKind` + `subjectRef` pattern already generalises
across `pricingDecisions`, `auditPackages` and `assistantCommitReceipts`.

What is missing is traversal. But the pattern for it exists: **`readinessComposer.ts` already answers
"why can't this unit leave?"** It composes driver, truck, trailer and job state into named blockers
with severities and overridability, and `dispatchReadiness` supplies the vocabulary. That is the
proposed query, built, for one question.

So this should be a generalisation of `readinessComposer`, not a new graph engine beside it. Two
things that answer "what is blocking X" would be the same defect as two `resolveRate`s — and this
time it would be the one the AI secretary reads. Two rate tables produce two dollar figures and
somebody notices; two blocker engines produce two fluent English sentences, both plausible, and
nobody can tell which is authoritative, the narrator included.

**One thing to fix while generalising: a gate and an explanation want different return shapes.**

`readinessComposer` answers *may this dispatch proceed*. "Why can't Unit 214 leave?" has the same
subject and a different question, and its honest answer is sometimes not a blocker at all — *it can
leave, but its CVIP expires Thursday.*

The type has nowhere to put that:

```ts
export type BlockerSeverity = "blocking" | "review" | "unknown";
```

Every member is a reason the answer is not yes. There is no `inform`, so the fact is not even
coerced into a weak severity — it is dropped, because nothing in `DispatchBlocker` can carry it.

A second channel does exist: `ComposedReadiness.contributions: { engine, finding }[]`. But it holds a
different kind of content — `readinessComposer.ts:224` records *"Licence read from the legacy
operator record — no structured credential yet"*, which is the evaluation explaining its own
provenance, not a fact about the truck. Overloading it would blur "what is true of this unit" with
"how this evaluation came to know it", which is `verified: boolean` doing measurement and permission
at once, one level up.

**Correction to the above: two of those channels already exist, and this was solved once already.**

`ComposedReadiness` also carries `capabilities: CapabilityResult[]` and `capabilityVerdict`, with a
header saying why:

> P8.1 — one result per capability this dispatch reads, including the ones that were never asked.
> The eligibility above is unchanged and still governs; this is what the eligibility could not say,
> because a verdict assembled from blockers cannot distinguish a capability that passed from one
> that was never consulted.

Somebody hit this exact problem and added a parallel channel rather than widening `BlockerSeverity`.
The boundary vocabulary (`server/_core/interEngineStatus.ts`) is
`"PASS" | "REVIEW" | "BLOCKED" | "UNKNOWN" | "NOT_EVALUATED"`, where `NOT_EVALUATED` carries a
required `NotEvaluatedReason` — `module_disabled`, `not_licensed`, `not_applicable`,
`no_data_source_loaded` — and its own rule that it never rounds up to `PASS`.

So:

- **A positive is already sayable.** `PASS` exists at the boundary type; it is only
  `BlockerSeverity` that has no affirmative member.
- **"The CVIP is missing" versus "I could not determine the CVIP" is already expressible** —
  `UNKNOWN` against `NOT_EVALUATED` with a reason. That is the provenance distinction, built, with
  no unexplained `NOT_EVALUATED` permitted.

What is genuinely missing is narrower than a third channel: a **non-blocking fact about the
subject** — a `PASS` that carries a qualifier, *valid, and expiring Thursday*.
`CapabilityResult.detail` is free text ("What a person should read. Never a score.") and could hold
the sentence, but nothing structured carries the horizon, so nothing can sort by it, alert on it, or
pack it into an offline brief.

**So do not design three channels. Extend `CapabilityResult` with a structured non-blocking
qualifier and let the explanation read all of it.** Building a new fact channel beside `capabilities`
would be the parallel system `interEngineStatus.ts`'s own header was written to refuse: *"Building a
fifth union and refactoring four engines onto it would be the parallel system this is meant to
avoid."*

---

## Sequence implied by the dependencies

1. **Production release track** (§8) — process only, and it changes how everything else is judged.
2. **Contacts** (§1) — blocks the emergency directory, the job contact package and the offline pack.
3. **Emergency operations** (§2) — needs §1; the preparation half, not the response half.
4. **Journey** (§5) — one entity over built legs; carries check-in, which §2 needs.
5. **Sensor vocabulary** (§4) — extends `measurementDevices` / `telemetrySnapshots` in place.
6. **TDG reference + SDS library** (§3) — independent of the rest; gated on regulatory source rights.
7. **Offline package contents** (§6) — assembles §1, §2, §3, §5. Last, not first.
8. **Scenario engine** (§7) — traverses everything above; only useful once they exist.
9. **Operational graph** (§9) — generalise `readinessComposer` as the others land, not before.

None of this displaces the audit's Phase A. Storage authorization, production secret validation and
the tenancy contradiction stay ahead of all nine.
