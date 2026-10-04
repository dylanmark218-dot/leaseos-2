# SPINE item 4a: dispatch gate and `jurisdiction`. Survey only (2026-10-04)

**No production code, no migration.** This is a survey against `main` `1f24b16b`, taken after SPINE item 3 was verified on main. It answers what the dispatch gate is, what "jurisdiction" means in this repository's contracts, and whether `server/_core/jurisdiction.ts` belongs in the dispatch gate at all. Implementation waits for the owner's ruling on the questions in §9.

## 1. The engine the census names

`server/_core/jurisdiction.ts` is pure. It has no database access, no network calls, and no boundary data of its own.

**What it does.** `decideJurisdiction({path: LngLat[], boundaries: BoundaryPolygon[], fallbackProvince?})` returns a `JurisdictionDecision`:

```
{ province: string | null,
  confidence: "confirmed" | "probable" | "ambiguous" | "unknown",
  authorizationEligible: boolean,
  crossing: { detected, fromProvince, toProvince } | null,
  reason, evidence[] }
```

- It decides the province of **one road path** from verified boundary polygons.
- `confirmed` requires a verified boundary layer, with every sampled point inside one polygon.
- `fallbackProvince` is never promoted above `probable`.
- When the path crosses a boundary, the result is `province: null`, `ambiguous`, and the two endpoint provinces only. It does not return the full set of provinces crossed.
- When no boundary layer is loaded, the result is `probable` with the fallback, or `unknown`.

**Its supporting exports:** `pointInRing`, `pointInPolygon` and `provinceAt`.

**Tests.** The only test file is `server/jurisdiction.test.ts`, using synthetic AB/BC squares. One test is misnamed: lines 75–81 say "catches a crossing hidden between two vertices" but assert `confirmed`.

**No production importer.** The census reason (`engineReachability.test.ts:107`) reads "profile lookup; callers use their own". That does not describe this module; it fits HOS `selectProfile`. **The reason is stale.**

**Intended callers, according to the docs:**
- `SPINE_WIRING_PLAN.md:17`: "dispatch gate, routing";
- `unified-compliance-engine-design.md:469–470`: jurisdiction "decided from structured route/job geography (`jurisdiction.decideJurisdiction`, verified layers only); unknown ⇒ UNKNOWN(missingInputs: ["jurisdiction"])";
- implementation plan C4: "wiring `jurisdiction.decideJurisdiction` for route-derived jurisdictions."

## 2. The dispatch gate today

**The award path:**
- `dispatch.readiness` (preview) and `dispatch.evaluate` (persists to `dispatchEligibilityChecks`), then `dispatch.award` (`dispatchRouter.ts:333`);
- `award` recomputes `composeReadiness` (`readinessComposer.ts:453`), then runs `awardAssignment` (`dispatchTransaction.ts:73`: posting `FOR UPDATE`, conflict re-check), then `decideAward` (`dispatchAward.ts:253`);
- it writes `dispatchAuditEvents`, `dispatchRoles` and `resourceBookings`.

**Other paths that call the same composer:**
- `jobUnits.create`, through `createJobUnitGated` (`dispatchEnforcementService.ts:91`);
- `shifts.award`, through `awardPost` (`shiftAwardService.ts:106`);
- the portal, the driver portfolio, open-shifts previews and widgets.

**`ReadinessSubject`** (`readinessComposer.ts:66–95`) is `{operatorId, unitId, trailerId, jobId, postingId?, routeApprovalRef?, loneWorker?, workEndsAt?, enforcement?}`. **It has no jurisdiction input.**

**What the composer checks:**
- **The operator:** licence, TDG (when the load is dangerous goods), Academy and portfolio bindings, medical fitness, field device.
- **The unit and trailer:** credentials, defects and mechanic releases, holds, insurance, roadside and enforcement orders, calibration, telematics faults.
- **The rest:** destination acceptance, HOS (attestation only), route approval, the communications plan, automation-policy capability, and `ruleSetHash` / `EligibilityFacts`.

**Permits are not checked today:**
- `readinessComposer.ts:838` hardcodes `permitRequired: false`;
- there is no permit model (that is C6);
- permits reach dispatch only inside a route approval's dependency hash (`permitVersion`, `:1101–1103`).

**Where jurisdiction appears at all.** Only through route-segment geography inside the communications plan (`:979–1003`), which is about radio rules. A jurisdiction gap there surfaces as `communication_geometry_missing` ("no usable road geometry"), mislabelled as a geometry gap. And `route_data_unverified` can never fire, because `route.dataTrustworthy` is always `null` (`:962`).

## 3. What "jurisdiction" means here: there is no single meaning

| Consumer | Meaning | Shape | Source |
|---|---|---|---|
| Requirement applicability (design §, `:485`) | **jurisdictions crossed, from the approved route** | set | route |
| HOS (`hos.ts:172–173`) | the carrier's regulatory jurisdiction of operation, "not its position" | scalar + `crossedBoundary` | caller |
| Comms / `decideJurisdiction` | province of each road segment | scalar per segment | geometry |
| Class 1 restriction (`driverTraining.ts:269–277`) | destination | scalar | caller |
| IFTA (`iftaEngine.ts:43`) | distance per jurisdiction | set with fractions | operator-stated |

**No contract defines a single dispatch jurisdiction as a scalar.** The documented dispatch need is the route-crossed **set** (C4), while the engine answers per segment. Turning segment answers into that set is an unwritten step. A trip from Alberta to British Columbia must be a set, and a crossing is `ambiguous` until it is measured.

## 4. Data sources and provenance

**Structured geography that exists:**
- `jobs.latitude` / `longitude`. `location` is free text, with no province or LSD.
- `facilities.province varchar(2)`, with `legalLocation` and coordinate precision and verification fields.
- `locationIdentities.province` plus coordinates with source and confidence. Note `spatialRouter.ts:29` defaults `province` to `"AB"`.
- `operatingZones` (a geofence with a source; no province).
- `roadSegments` / `segmentAttributes` / `roadRestrictions` / `routeEvidenceEntries.jurisdiction`.
- `externalDataSources.jurisdiction`: the jurisdiction of the **dataset**, not of each point.
- `hosRuleProfiles.jurisdiction`.

**What does not exist:**
- `trips` and `tripStops` carry no geography of their own; they hold ids to locations and facilities.
- There is no boundary-polygon table, no permits table, and no `readinessSnapshots` table.

**Provenance.** The only jurisdiction-with-source pair is `fuelTransactions.jurisdiction` + `jurisdictionSource` (an IFTA concern). `sourcePrecedence.ts` ranks road-posture claims and says nothing about jurisdiction. Unknown is represented as `JurisdictionConfidence "unknown"` and as `MissingSegmentGeography.reason "jurisdiction_unknown"`.

**Existing duplicate province derivations** (the same question as the engine):
- `routeCommunicationGeography.ts:207–221`: the dataset's jurisdiction, only when the source is verified, as `probable`, with `crossing` always `null`. This is the slot `decideJurisdiction` is designed for (`fallbackProvince`).
- `legalLand.ts:167–219` `standingFor`: hardcoded per source key (`CA-AB`/`CA-BC`/`CA-SK`), and **without** the verified-source requirement. The two disagree.

**Code formats differ.** HOS seeds and engine tests use `"AB"`; requirements, sources, IFTA and GST use `"CA-AB"`. `provinceFromJurisdiction` converts in one direction only.

**Hardcoded Alberta where the value is unknown:**
- `driverTraining.ts:276–277`: a Class 1 check with a null destination is treated as "an Alberta-only movement". **This fails open on an unknown jurisdiction.**
- `dls.ts:53`: an LSD identity always gets the prefix `AB:`, even for meridians W1–W3.
- Defaults that are not dispatch: `invoicingRouter.ts:195` `.default("CA-AB")`; `spatialRouter.ts:29` `"AB"`; `facilityDirectoryRouter.ts:491` `"AB"`.

## 5. Route crossings

- The only code that detects a crossing is `decideJurisdiction`, which is unwired, and it has no boundary data.
- `routeCommunicationGeography` sets `crossing = null`.
- HOS `crossedBoundary` is supplied by the caller.
- IFTA splits are stated by the operator.
- With no route approval, the base gate already reports `route_not_evaluated`, an unknown that a manager must resolve.

## 6. Emergency

- `dispatchReadiness.ts:15–16`: "Emergency does not bypass safety. `priority` is not an input to this function at all." This is pinned by `dispatchReadiness.test.ts:279–292`.
- The only effect of emergency is commercial: a missing PO or AFE becomes review instead of a block (`commercialLifecycle.ts:161,174–176`).
- Nothing about emergency touches jurisdiction. Wiring must not add one.

## 7. Tenant scope

- `dispatchScopeFor` / `assertReadinessSubjectInScope` (`dispatchEnforcementService.ts:59–80`): the operator by ownership, `unitInScope` and `jobInScope`. Anything out of scope reads as not found.
- `jobInScope` is applied to postings, and check rows store `orgRef`.
- Cross-organization refusal is pinned at `complianceReadinessC1a.db.test.ts:471`.
- A jurisdiction derived from the subject's records inherits that scope. A client-supplied jurisdiction has no entry point in `composeReadiness` today, and that must stay true.

## 8. Persistence: no migration is needed to start

- `dispatchEligibilityChecks` has `blockersJson`, `capabilitiesJson`, `fingerprint` and `ruleSetHash`, but no jurisdiction column.
- `EligibilityFacts` (`dispatchAward.ts:29–101`) has no jurisdiction field, so today a change of jurisdiction would not make a check stale.
- A first wiring can carry the result in the facts that produce the fingerprint, and in a blocker or capability entry, with no schema change.
- A durable jurisdiction-with-provenance record and boundary polygons would need tables. That is not a decision for this survey.

## 9. What should stop implementation until the owner rules

1. **The engine is not the dispatch-gate seam.** Its input is a road path, which the dispatch subject reaches only through `routeApprovalRef → segmentIdsJson → buildRef` in `routeCommunicationGeography`. The design doc places this wiring in C4 (route-derived jurisdictions), not in the composer. Putting it in the composer would be a **fourth** derivation beside the comms resolver, `legalLand.standingFor` and HOS's caller-supplied value.
2. **It has no data.** There is no boundary-polygon table and no seed. Wired today, it returns what `routeCommunicationGeography` already returns (`probable` or `unknown`, never authorization-eligible). Nothing changes until verified polygons exist.
3. **The meanings conflict.** HOS uses the regulatory jurisdiction, Class 1 uses the destination, the design uses the route-crossed set, and the engine uses per-segment province with a from/to crossing. A single scalar "dispatch jurisdiction" would contradict `hos.ts:172` and design `:485`.
4. **Consumers that do not exist yet.** Permits (`permitRequired: false`, no model) and Academy jurisdiction bindings (deliberately never match) would be jurisdiction consumers in the gate, but they are unbuilt (C6) or pinned off.
5. **Two source-wide derivations disagree:** `legalLand.standingFor` (unverified allowed) versus the comms resolver (verified only).
6. **Existing defects found** (outside this survey's scope, recorded):
   - the Class 1 null destination is treated as Alberta-only;
   - the `AB:` LSD prefix for every meridian;
   - the mislabelled `communication_geometry_missing`;
   - the stale census reason;
   - the misnamed engine test.

## 10. Proposed RED tests (for whichever seam is ruled)

1. A known single jurisdiction gives `confirmed` (verified layer) or `probable` (dataset), with its source.
2. A cross-jurisdiction trip gives a **set** {AB, BC}, `ambiguous` per crossing segment, and is never collapsed to one province.
3. A route crossing a third jurisdiction that is neither endpoint appears in the set.
4. Missing route geometry gives `unknown`, `missingInputs: ["jurisdiction"]`, and never Alberta.
5. Conflicting facility and job geography is reported as a conflict, not resolved by picking one.
6. Stale jurisdiction evidence makes the check stale (the fingerprint moves).
7. A client-supplied jurisdiction cannot override server facts: there is no input path, and an extra field is stripped.
8. A trip or job belonging to another organization reads as not found, and cannot be used to derive a dispatchable jurisdiction.
9. A required permit for a derived jurisdiction is unknown or blocked while no permit model exists (C6). Expired or missing permit tests wait for C6.
10. Route data unavailable gives the existing `route_not_evaluated` unknown.
11. Emergency with unknown jurisdiction is still not allowed (no priority input).
12. The result is the same whatever the input or row order (sorted set, stable fingerprint).
13. The check row's fingerprint and blockers record the server-evaluated result.
14. The Class 1 regression: a null destination is **unknown**, not "Alberta-only".

## 11. The smallest wiring that respects the contracts (for the ruling)

**(a)** Wire `decideJurisdiction` into `routeCommunicationGeography`, the existing route-geography resolver, with `fallbackProvince` set to the verified dataset province. That makes the engine the single per-segment answer and replaces the hardcoded `crossing = null`. It also needs:
- an aggregation from segments to a route jurisdiction **set** with confidence and evidence;
- exposing that set to the composer as an input to readiness (as `missingInputs` / unknown where it is unknown), carried into `EligibilityFacts`;
- removing or demoting `legalLand.standingFor`'s unverified province claim.

There is no migration while no boundary layer exists. The engine stays `probable`/`unknown` until verified polygons are loaded, so no answer becomes more permissive.

**(b)** Or rule that 4a's jurisdiction is not reachable until C4/C6 (route jurisdictions, permits) and boundary data exist, and move on to the next 4a seam.
