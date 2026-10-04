# Commercial route legality (T2)

How LeaseOS decides whether a unit may legally use a route, and how that answer reaches dispatch
readiness. This extends the existing route path (`routeEvaluation`, `routeApprovals`, `structures`,
`routeDependencies`, `readinessComposer`); it is not a new engine (SPINE moratorium, D-01).

The checkpoint record, with gate results, is
[`checkpoints/T2_COMMERCIAL_ROUTE_LEGALITY.md`](checkpoints/T2_COMMERCIAL_ROUTE_LEGALITY.md).

## The flow

```
spatial.routeEvaluateSegments ─► routeLegality.evaluateSegments ─► routeEvaluation.evaluateRoute
          │                         │  profile + routingWeightFor (P1)
          │                         │  restrictions in force (dated), road bans → rule ledger (P2)
          │                         │  bridges, structures — every one contributes (1B)
          │                         │  segment jurisdiction cross-check (P3)
          ▼
   routeEvidenceEntries (evaluationRef)
          │
spatial.routeApprove ── verdict DERIVED from that evaluation (defects 2, 3)
          │              fingerprint incl. measuredWeight + legalRules (P4)
          ▼
composeReadiness ── unit must match · live recheck (stale?) · re-run evaluateSegments
                    → route_check_failed_* / _unknown_* / _review_* blockers (P5)
```

## Most restrictive applicable evidence (defect 1)

For one check on one segment, every **applicable** limit is evaluated. Applicable means all of
these hold:

- it is the same check;
- it is on that segment;
- it is in force on the evaluation date;
- it is in a unit the check understands;
- it is not superseded.

There is no blind `Math.min`. Each limit is evaluated, and then:

- **The worst result governs:** FAIL > UNKNOWN > REVIEW > PASS.
- **Within a result, the tightest limit is cited.** The reason names the controlling record and
  how many were applicable.
- **A lower authority may tighten, never loosen.** An unverified limit that fails still fails. An
  unverified limit that passes cannot raise a verified limit that fails. A pass that rests on
  unverified evidence keeps its lower confidence.
- **A unit the check does not understand is UNKNOWN** (for example a weight limit recorded in `t`).
  It is never converted by guesswork, and never passed.
- **A recorded limit is evaluated even if the caller did not ask for its check.** Asking only about
  road gross weight does not hide a 45,000 kg bridge.

The router passes **every** road restriction, bridge and structure limit to the evaluator (1B). The
evaluator picks the controlling limit. `applicableRestrictions` still collapses rows *within* one
check to the most restrictive verified row, plus a list of what each row's date window set aside.

## Weight (P1)

`routingWeight.routingWeightFor` chooses the weight. It does not re-decide authority. It reads the
legal determination that LoadSense ingest froze on the snapshot (`legalDetermination`, 0159), and
`measurementQuality.authorityForWeightSource` for the authority label.

| Reading available (trip → job → unit within 12 h) | Weight used | Effect |
|---|---|---|
| Legally determined | The measured gross weight and every measured axle group, whether heavier or lighter than declared | Controls |
| Measured, not legally determined | Whichever of measured and declared is heavier | Can tighten. A weight check it passes becomes REVIEW |
| None | The declared profile | As before |

- Every axle group is evaluated, not only the heaviest.
- A group's legal type (single, tandem or tridem) comes from the declared axle count of the group
  with the same key. A group with no recorded axle count is UNKNOWN under a road ban.

## Road bans (P2)

A percentage road ban (`road_ban_level`, unit `%`) is a fraction of a **verified legal axle
allowance**. That allowance is read from the generalized rule ledger:
`believedRuleOn("axle_load_limit", "CA-XX", at)`, family `AXLE_LOAD_RULE_FAMILY`.

```
allowance(group type) = floor(base rule[group type] × percent / 100)
```

The ban resolves to UNKNOWN, with the reason, when any of these holds:

- no percentage is recorded;
- no verified rule is in force for the jurisdiction on that date;
- the rule states no allowance for one of the vehicle's group types;
- the jurisdiction cannot be resolved;
- the jurisdiction conflicts with the road data (P3).

A ban is never estimated, and never borrows a neighbouring jurisdiction's rule. A seasonal increase
(for example 110%) uses the same arithmetic. Dated windows come from the existing `effectiveFrom`
and `effectiveTo`: an expired or not-yet-in-force ban is set aside and named in `dateNotes`.

> **Rule data.** No axle-load rule is loaded. A ban therefore reads UNKNOWN until a person promotes
> the jurisdiction's rule through the ledger: citation on a recognized authority domain, and two
> verifiers for a BLOCK rule backed by law. That is deliberate; nothing is seeded.

## Segment jurisdiction (P3)

Each segment's rule context is the jurisdiction on the **verified restriction** that invokes the
rule: one person recorded it and a second verified it against a source document.

`resolveRouteCommunicationGeography` gives only a "probable" province, read from the road dataset.
It is used only as a cross-check. When it is known and disagrees, the rule does not apply and the
check is UNKNOWN. The origin's province is never propagated along the route.

## Permits: deferred (D-01, owner decision 2026-10-01)

No movement-permit schema, permit determination, permit lifecycle or OCR-to-rule work is in T2. No
permit migration exists either (0210 is not used).

Permit references on an approval stay free text, stored only as a hash (`permitSet`). A recheck
carries that hash forward and **says so**: `notRechecked: [{ dependency: "permitSet", … }]`. This is
defect 4, case B. It does not fake verification and does not overload the hash. Recorded in
`docs/compliance/unified-compliance-engine-design.md` §23 (T2-D1).

## Staleness (P4)

`RouteDependencies` gains two optional keys. Approvals recorded earlier are compared only on the
keys they carry.

| Key | What it hashes | Moves on | Does not move on |
|---|---|---|---|
| `measuredWeight` | Weight basis, gross, and each group (key, kg, axles), all rounded to 100 kg | A heavier or lighter load · a load shifting between groups · a reading gaining or losing its legal determination | Sensor noise under 100 kg · a fresh snapshot of the same load · another unit's reading |
| `legalRules` | Each in-force ban's segment, ref, percent, jurisdiction, rule promotion ref and outcome | A rule revision (new promotion) · a ban coming into force · a jurisdiction conflict appearing | Another jurisdiction's rule · a restriction on another road |

A ban starting or ending also moves `restrictionSet`. That key holds only the *applied* (most
restrictive) rows, so adding a looser limit is not a material change.

## Readiness (P5)

There is no new gate. `composeReadiness`, for `routeApprovalRef`:

1. **Unit match.** It reads the approval only if `approval.unitId === subject.unitId`. Otherwise the
   result is `route_approval_missing` (UNKNOWN) and nothing of that approval is read. The subject's
   unit is the tenant-scoped fact, so this also closes a cross-tenant read: before T2 a foreign
   approval's status and stale reasons reached readiness.
2. **Live staleness.** It runs `recheckRouteApproval` at `now`. This is the same computation
   `routeApprovalCheck` uses, and it records a newly stale approval. A stale approval produces
   `route_approval_stale` (blocking), and its label names what changed.
3. **Current legality.** It re-runs `evaluateSegments` on the approval's segments and on the checks
   its evaluation covered, and emits:

| Evaluation result | Code | Severity | Override |
|---|---|---|---|
| FAIL | `route_check_failed_<check>` | blocking | never (`NEVER_OVERRIDABLE`) |
| UNKNOWN on a legal or feasible check | `route_check_unknown_<check>` | unknown | approved policy only |
| REVIEW, or UNKNOWN on a preferred check | `route_check_review_<check>` | review | warning acknowledgement |

Each label names the segment, the evaluator's reason (vehicle value, limit and controlling record),
and the source with its version. `evidenceRefs` carries `evaluation:<ref>`, `segment:<id>` and every
source. An approval with no recorded evaluation keeps `dispatchStatus = not_evaluated`, which becomes
`route_not_evaluated` (UNKNOWN).

Readiness does not know whether an escort is assigned. A segment that requires one therefore
re-evaluates as REVIEW ("none assigned").

## Not in T2

- Permit schema (D-01).
- TDG beyond the existing dangerous-goods check.
- HOS.
- Radio-road expansion.
- MapLibre, native GPS and offline maps.
- A new routing engine.
- A national regulation catalogue.
- Loading any jurisdiction's axle-load rule.
