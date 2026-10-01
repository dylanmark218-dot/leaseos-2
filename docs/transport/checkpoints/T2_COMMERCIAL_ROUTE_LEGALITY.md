# T2 — Commercial route legality: defects 1–4 fixed, vertical slice P1–P5

**Status:** implemented on `claude/commercial-route-legality-t2`. Not merged. Stopped before any
movement-permit work, per the owner's instruction.

| | |
|---|---|
| Base | `main` @ `c3f088b` (merge of #90, T1). Gated untouched before any change: PASS, 438 files, 6679 passed / 3 skipped |
| Commits | `16221c0` P0 (defects 1–4, red first) · `c328567` P1–P3 · `9c03ac0` P4 · `8a7aea4` P5 · this record |
| Gate-verified SHA | See *Gate result* below |
| Migration | **none**. Head unchanged at `0209_operating_zone_scope.sql`. No schema was needed, and 0210 is not used |
| Owner decisions | D-01 stays in force for permits (recorded as T2-D1 in `docs/compliance/unified-compliance-engine-design.md` §23). Defects first, then P1–P5 |
| Runtime | Node **22.23.3** (`.nvmrc`), tz **2026c** · **MariaDB 10.11.14** |
| Production | Unchanged. No feed scheduling, no keys, no timers. `LEASEOS_TRANSPORT_FEEDS_ENABLED` is not set |

The design is in [`../COMMERCIAL_ROUTE_LEGALITY.md`](../COMMERCIAL_ROUTE_LEGALITY.md).

## Defects: reproduced red on `c3f088b`, then fixed

Every test below was written before its fix and run against the untouched base.

### Pure evaluator: `routeLegalityDefects.test.ts`, defect 1A

6 tests, **6 failed on base**.

| Test | Before (base) | After |
|---|---|---|
| A 4.5 m vehicle, with a 5.0 m road clearance listed before a 4.2 m structure | pass: the first entry won | **blocked**. The 4.2 m structure controls |
| 50,000 kg, with a 63,500 kg bridge figure listed before 45,000 kg | pass | **blocked** |
| A recorded 45,000 kg bridge when only road gross was asked | not evaluated | **blocked**. Recorded limits are always evaluated |
| An unverified tighter limit against a verified looser one | the verified one won (loosened) | the unverified limit **tightens**. It never loosens |
| A weight limit recorded in `t` | compared as kg | **UNKNOWN** |
| Every limit satisfied | pass, no controlling record cited | pass, **citing the controlling 4.6 m** |

### Through the procedures: `routeLegalityDefects.db.test.ts`

6 failed and 10 passed on base. The passing ones are guards, such as "refuses to approve the
evaluation that failed".

| Defect | Before (base) | After |
|---|---|---|
| **1B** The router passes every limit | The router passed one row per check (road 5.0 m), so the 4.2 m structure was never seen. Still red after the router-only fix, until 1A was fixed too | **blocked** |
| **2** Verdict from the evaluation | A caller's `"clear"` was stored over an UNKNOWN evaluation, and readiness saw a clear route. Another unit's evaluation was accepted | Verdict derived from the evaluation's own evidence. `EVALUATION_NOT_FOR_THIS_ROUTE` when the profile, unit or segment coverage does not match |
| **3** FAIL and UNKNOWN scoped to the evaluation | Any historical FAIL on a segment refused every later approval. A current UNKNOWN could be stored as clear | Only the approved evaluation's FAIL refuses (`ROUTE_HAS_FAILING_EVIDENCE`), and the old FAIL row stays on record. UNKNOWN is never stored clear, whether the caller sent clear, review or warning |
| **4** Recheck dependencies | The recheck implied that permits were re-checked | Case B, a disclosure: `notRechecked: [{ dependency: "permitSet" }]`. The hash is not overloaded and no permit verification is faked |

`routeApprove` callers inspected. There is no client or mobile caller. The only callers are the
test suites (`structures`, `communications`, `commsDispatch`, `geographyAgreement`,
`canadianProviderRuntime.db` and the T2 suites). None relied on its claimed status being stored. The response now carries `dispatchStatus` (derived) and
`claimedDispatchStatus` (what the caller sent).

## Vertical slice: `routeLegalitySlice.db.test.ts`

25 tests, all on MariaDB through the real procedures.

| Part | Proven |
|---|---|
| **P1** weight | A legal 50,000 kg scale reading blocks a route the declared 20,000 kg would pass. One measured axle group over its limit blocks, and the group is named. A non-legal reading cannot establish compliance (REVIEW). A heavier non-legal reading still tightens |
| **P2** road bans | 75% of a verified 17,000 kg tandem allowance (12,750 kg) blocks a 14,000 kg tandem. An expired ban is set aside and named. **A missing base rule → UNKNOWN**. A 110% seasonal increase passes 18,000 kg |
| **P3** jurisdiction | Two jurisdictions on consecutive segments each use their own rule. A rule silent on single axles → UNKNOWN. An unresolvable "Municipal District 15" → UNKNOWN. Road data placing the segment in another province → UNKNOWN |
| **P4** fingerprint | New approvals carry `measuredWeight` and `legalRules`. These go stale: a material weight change, a shift between axle groups (`changed: ["measuredWeight"]`), a ban coming into force (`restrictionSet` + `legalRules`), a rule revision (`["legalRules"]`). These do not: ±20 kg noise, a restriction on another road, another unit's reading, another jurisdiction's rule |
| **P5** readiness | See the next table |

P5 readiness results:

| Case | Result |
|---|---|
| Valid evaluation and current approval | No route-legality blocker, so readiness proceeds to its other checks |
| Current FAIL | `blocked`. `route_check_failed_road_weight_restriction` is `NEVER_OVERRIDABLE`, and its label names the segment, 50000, 30000 and the `restriction RR-…`, with evidence refs to the evaluation and segment |
| Material UNKNOWN | Not clean eligible. `route_check_unknown_road_ban_level` names "no verified legal axle-load rule" and the jurisdiction |
| Stale approval | `route_approval_stale` is blocking and names "the restrictions in force changed". The approval is recorded `stale` |
| Tenant isolation | Org B's readiness given org A's approval ref sees only `route_approval_missing`, and none of A's segment, source or weight |

The tenant-isolation case was **red without the unit-match guard**: B's readiness received A's
`route_approval_stale` and its reasons. That leak existed before T2 and is closed here.

The pin moved in `structures.test.ts`: the dependency keys now include `legalRules` and
`measuredWeight`.

## Related suites run before the gate

49 files and 783 tests passed. They cover:

- every route, spatial, structures, readiness, dispatch, comms, C1a and complianceFinding suite;
- `canadianProviderRuntime.db`;
- `engineReachability`, `procedureAuthorization`, `crossLayerIntegrity` and `testIdBands`.

## Gate result

Command: `DATABASE_URL=mysql://root@127.0.0.1:3306/<fresh db> bash scripts/ci-gate.sh`, run with
the pinned Node.

*Recorded below after the run.*

## Unresolved limitations

1. **No axle-load rule is loaded.** Every percentage ban reads UNKNOWN until a person promotes a
   jurisdiction's rule through the ledger (two verifiers for a BLOCK law rule). This is deliberate:
   nothing is seeded.
2. **Permits are not modelled (T2-D1).** A route needing a permit can only be approved with
   free-text permit references. They are carried, not re-checked, and the recheck says so.
3. **Jurisdiction comes from the restriction.** Without a verified restriction there is no rule
   context for a segment. The geography resolver is only a cross-check, because it describes the
   road dataset.
4. **Readiness re-evaluates without knowing about escorts.** A segment that requires an escort
   re-evaluates as REVIEW ("none assigned").
5. **Axle type comes from the declared profile.** A measured group whose key matches no declared
   group has no axle count, so it is UNKNOWN under a ban.
6. **Readiness now costs more.** Each readiness call that names a route runs one recheck and one
   evaluation. Both are bounded by the route's segments.

## Next recommended checkpoint

Owner choice, recommended in this order:

1. Promote Alberta's legal axle-load allowances through the ledger, with a citation and two
   verifiers. Bans then resolve rather than read UNKNOWN.
2. A ruling on lifting D-01 for movement permits (C6). After that, permits become rows, and
   `permitSet` hashes permit revisions.
