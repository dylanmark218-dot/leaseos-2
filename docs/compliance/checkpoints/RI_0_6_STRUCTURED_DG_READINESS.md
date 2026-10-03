# RI-0.6 — Structured dangerous-goods readiness

**Written on:** `origin/main` `42c454f` (v23.25, migration tip `0174`), branch
`claude/ri-0.6-structured-dg-readiness` (`2a2aae2`), never merged.

**Reconciled onto:** `origin/main` `2864723` (v23.31, 207 migrations, tip
`0236_compliance_document_recorder`), branch `claude/ri-0.6-dg-readiness-current-main`. See
"Reconciliation onto current main" at the end.

**Migrations:** none. **Scope:** the authority boundary that feeds dispatch readiness with the job's
dangerous-goods state. Nothing else.

> **Operational effect (read first).** No production procedure sets a load's `classificationStatus`
> to `verified`. This was true when RI-0.6 was written and is still true on `2864723`: the only
> write path, `fieldRoute.compliance.loads.create` (`server/routers.ts`), always stores
> `needs_verification`. So once this lands, every production job reads dangerous goods as
> **UNKNOWN**. A job with no load is `no_load`; a job with recorded loads is
> `classification_unverified`. Readiness blocks dispatch, and an override is possible only under an
> approved policy (`APPROVED_POLICY_ONLY`). That is the fail-closed answer the invariants require.
> Before this, the system said "not dangerous goods" whenever a job's wording happened not to match
> a regex. The way out is a verification path for loads (RI-6b), not a softer rule.

## What was wrong, exactly

`server/readinessComposer.ts` derived the job's dangerous-goods state in two steps at the start of
this checkpoint (post-C1a):

1. `dangerousGoodsAuthority(loads, freeTextSuggestsDg)` read the job's `loadProfiles` rows —
   correct — but took a second argument computed as
   `/tdg|dangerous|hazard/i.test(`${job.type} ${job.mode}`)`.
2. With **no load recorded**, that regex decided the outcome: a hazardous-looking word gave
   `unknown` (blocker `dg_classification_missing`); an innocent word gave **`not_applicable`** with
   no blocker, and the composer then set `dangerousGoods = false`, `tdgDocumentPrepared = true`
   and `emergencyPlanOnFile = true`.

So the absence of a regex match still proved non-dangerous cargo for every job without a load
record. A second defect: with several loads, one unverified load returned `unknown` **before** the
verified DG loads were looked at, so a verified UN1203 load beside an unresolved drum lost its TDG
requirements. Before C1a (T0's finding) the regex was the only authority; C1a removed it from the
decision and left it as the "suspicion" signal that this checkpoint removes.

Every production consumer of the decision is in the composer: the TDG-certificate requirement, the
`job` slice of `ReadinessInput` (`dangerousGoods`, `tdgDocumentPrepared`, `emergencyPlanOnFile`), the
communications blockers (`possiblyDangerousGoods`, tighten-only), the `dangerous_goods` contribution
line, and `materialClassificationVersion` in the eligibility fingerprint.

## The authoritative structured model (verified, not assumed)

`loadProfiles` (`drizzle/schema.ts`, migration 0003): `jobId` (many rows per job — a job can carry
several loads), `material`, `unNumber`, `properShippingName`, `dgClass`, `packingGroup`, `quantity`,
`isWaste`, `classificationStatus ∈ {needs_verification, verified, blocked}` (default
`needs_verification`), `source`, `confidence`, `verifiedAt`. The only production write door,
`fieldRoute.compliance.loads.create`, refuses caller-supplied `classificationStatus`/`verifiedAt` and
stores `needs_verification` ("TDG is never self-certified"). **No production procedure on `main` sets
`verified`** — `compliance.dangerousGoodsAssist` is stateless and writes nothing. So in production
every recorded load is unverified today and readiness answers UNKNOWN until a verification door exists
(RI-6b). That is the honest answer and it is not softened here. There is no subsidiary-class,
placard, ERAP or shipping-document field; those stay RI-6b. No duplicate cargo storage was created.

`loads` (load identity, chain of custody, measurement) has `material` text and no classification; it
is not a DG authority and is not consulted. `jobs.type` is free text; `jobs.mode` is an enum with no
cargo meaning. Neither is consulted.

## Behaviour now

`dangerousGoodsAuthority(loads)` — one argument; the job's wording has no path into it — returns
`{ state, dangerousGoods, reason, loads, blockers, version, explanation }`:

| Loads on the job | `state` | `dangerousGoods` (requirements apply) | `reason` | blocker |
|---|---|---|---|---|
| none | `unknown` | false | `no_load` | `dg_classification_missing` (UNKNOWN, BLOCK, approved-policy override only) |
| all verified, none DG | `not_dg` | false | `verified_not_dg` | — |
| any verified DG | `dg` | **true** | `verified_dg` | plus `dg_classification_unverified` for any unverified sibling |
| verified non-DG + unverified | `unknown` | false | `classification_unverified` | `dg_classification_unverified` |
| any refused | `blocked` | true iff a verified DG load exists | `classification_blocked` | `dg_classification_blocked` (blocking, never overridable), then any unverified |

`tdgDocumentPrepared` and `emergencyPlanOnFile` read `true` **only** from an authoritative `not_dg`;
`dg` gives `null` (the existing `tdg_document_unknown` path), `unknown`/`blocked` give `null`. The
contribution line is `${state} (${reason}): ${explanation}`, so the readiness response names why
applicability is unresolved. The fingerprint input (`materialClassificationVersion`) is unchanged in
form and now cannot be moved by renaming a job.

**Legacy jobs.** A job with no `loadProfiles` row — every job created before the load-profile door
existed, and every non-cargo job — now reads UNKNOWN with `no_load`. There was no compatibility
mechanism for such jobs other than the regex, and the regex is the thing that could not be kept. The
blocker is `APPROVED_POLICY_ONLY` under the C1a catalogue, so operations proceed by recording a
classification (one row) or under a named policy, never silently.

## Tests

Pure (`server/_core/complianceFinding.test.ts`, "RI-0.6" block): cases A–G as the owner listed them,
a fingerprint-version case, and a source scan asserting the composer contains no free-text
dangerous-goods inference. Database (`server/complianceReadinessC1a.db.test.ts`, "RI-0.6" block):
D (no load → UNKNOWN with `no_load` on the record; classified load clears it), E (verified DG beside
unverified → TDG requirements plus the unverified finding), A/B (wording moves nothing), and the
fingerprint moving with a load's classification and not with the job's name. The established-subject
fixture now carries a verified non-DG load; tests about the missing-classification case ask for
`{ classifiedLoad: false }`.

## Regression search (Step 10)

| Site | What it does | Verdict |
|---|---|---|
| `server/readinessComposer.ts` (the regex) | decided DG applicability with no load | **removed here** |
| `server/_core/customerProjections.ts:57` `/tdg\|dangerous/i` | maps a blocker **code** to the customer-facing category label "TDG certification" | display vocabulary over codes, not an authority; unchanged |
| `server/_core/hydrovacList.ts:61` `/…hazardous…\|dangerous goods/i` | parses a published facility listing into a `hazardousAllowed` lead for the facility directory import | facility-evidence lead (review state `lead`), never a load or readiness authority; listed for RI-6b/facility work, unchanged |
| `server/_core/complianceSecretary.ts` `evaluateDangerousGoodsAssist` | consumes a caller-supplied structured `classificationStatus`; refuses to guess when unverified | structured input, unchanged |

No other production site infers regulated state from free text.

## Fingerprints (Step 11)

DG state already participates: `dgAuthority.version` (sha256 over each load's id, status, UN number,
class, packing group, verifiedAt) is `facts.materialClassificationVersion` and enters
`computeEligibilityFingerprint`. Changing a load's classification changes the fingerprint (pinned);
renaming the job no longer does. Route fingerprints (`structures.RouteDependencies.loadProfile`) take
the caller's `load.dangerousGoods` and are untouched — RI-2/RI-4b feed them from the same authority.
Offline data: no package carries DG state on `main` (RI-9). Assignment eligibility reads the
readiness verdict and inherits the change.

## Follow-ups (RI-6b, unchanged in scope)

A verification door for `loadProfiles.classificationStatus`; structured DG lines (subsidiary class,
quantity, placard); shipping-document and ERAP state from records; `ReadinessInput.job.dangerousGoods`
as a tri-state; the facility-listing parser's `hazardousAllowed` as an evidence claim with a licence key.

## Reconciliation onto current main (2026-10-03)

I started from a green baseline. On untouched `beafeeb`, `scripts/ci-gate.sh` passed: test-file
typecheck 0 errors, 490 files, 7446 tests passed and 3 skipped, fixture isolation 67/67, and the
current-state document current. GitHub's CI on `beafeeb` was cancelled when `2864723` superseded it;
its run on `2864723` passed. This branch was cut from `beafeeb` and rebased onto `2864723`. #133
touches none of these files.

**Replayed, not merged.** I replayed the old branch's three commits onto a fresh branch with
`cherry-pick -n`:

| Original | Here | Notes |
|---|---|---|
| `d337bd4` test: pin structured DG authority | replayed cleanly | — |
| `19ed80e` fix: derive DG readiness from structured loads | replayed with one conflict | main had inserted the v23.31 commercial-readiness block between the DG lines in `composeReadiness`; both are kept, unchanged |
| `2a2aae2` docs | this file, updated | — |

Changes dropped or added during replay:

- **Dropped:** `19ed80e`'s `LEASEOS_CURRENT_STATE.md` edit. That was the old numeric test-count
  row, which CI-STATE-1 removed from the committed document. The regenerated document is unchanged
  by this branch.
- **Already on main:** nothing. Main still had the two-argument `dangerousGoodsAuthority`, the
  regex, `not_applicable`, and `tdgDocumentPrepared` / `emergencyPlanOnFile` set to `true` for
  anything not verified DG.
- **Added for current main:**
  - Case H, the full eight-row truth table, with UNKNOWN + UNKNOWN new.
  - Two composer cases: FALSE + UNKNOWN and UNKNOWN + UNKNOWN; a legacy job with plain wording and
    no load.
  - A verified non-DG load in the scenes of `shiftAward.db` and `shiftAwardConcurrency.db`. Those
    suites were written after RI-0.6, and without a classified load their "established" job is
    UNKNOWN, so seven award cases were refused with `readiness_refused`. This is the same fixture
    rule RI-0.6 applied to `dispatchGate` and `dispatchEnforcement`.

**RED → GREEN.** Against `main`'s composer, 13 RI-0.6 cases fail (all of A–H, the source scan,
and the four composer cases). With the fix, all pass.

### Truth table (case H)

| Structured loads | `state` | DG requirements apply | Unresolved surfaced |
|---|---|---|---|
| TRUE | `dg` | yes | — |
| FALSE | `not_dg` | no | — |
| UNKNOWN | `unknown` | no | yes |
| no structured load | `unknown` (`no_load`) | no | yes |
| TRUE + FALSE | `dg` | yes | — |
| TRUE + UNKNOWN | `dg` | **yes** | yes (`dg_classification_unverified`) |
| FALSE + UNKNOWN | `unknown` | no | yes |
| UNKNOWN + UNKNOWN | `unknown` | no | yes (both loads listed) |

### Canonical model on current main

`loadProfiles` is still the only structured authority. `manifests.unNumber` belongs to a shipping
document that references its load through `loadId`; it is not read by readiness and is not a second
authority. The DG-looking columns on `incidentReports`, `roadsideServiceEvents` and
`academyStatementsOfExperience` describe events and experience, not cargo. No adaptation and no new
storage.

### Free-text and asserted-fact search on current main

Free text: none decides regulated state. No production code tests a job's type, mode, description,
notes or title against text. `customerProjections` maps blocker codes to labels, `knowledge/perimeter`
routes questions, `complianceSecretary` writes prose, and `hydrovacList` derives facility leads (as
before).

**Caller-asserted DG flags that default to "not dangerous".** These are not free text, and none goes
through `dangerousGoodsAuthority`, so per scope they are recorded here, not changed:

| Site | What happens when the caller omits DG |
|---|---|
| `spatial.routeApprove` / `spatial.routeEvaluateSegments` (`load.dangerousGoods: z.boolean().default(false)`) | the route is evaluated and approved as non-DG; **readiness then accepts that approval for a job whose verified load is DG, with no cross-check against `dgAuthority`** |
| `requirementEngine.evaluateWorkContext` (`ctx.cargo?.dangerousGoods ?? false`, via `requirementRouter`) | work-context requirements evaluate as non-DG |
| `routingCompiler` (`Boolean(input.cargo?.hazardous)`) | compiled routing input is non-DG |
| `compliance.passport` attributes (`handlesDangerousGoods`) | an omitted attribute makes the TDG-certificate requirement not apply |

The first is the one that matters for Route Intelligence. A route's DG basis should come from the same
structured determination as readiness (RI-2 / RI-6b).

### Fingerprints and dependencies on current main

| Consumer | DG determination a dependency? |
|---|---|
| Dispatch readiness | **yes**: TDG certificate requirement, `job` slice, communications (tighten-only), the `dangerous_goods` contribution |
| Dispatch / eligibility fingerprint | **yes**: `facts.materialClassificationVersion = dgAuthority.version` → `computeEligibilityFingerprint` |
| Assignment / award | **yes**: `dispatchAward` recomputes the same fingerprint from current facts, so a reclassified load invalidates a held check |
| Route fingerprint | **no**: `routeApprovals.fingerprintHash` hashes the caller's `load.dangerousGoods`; readiness reads the route's `routeDecisionVersion` but does not compare its DG basis (record for RI-2) |
| Compliance findings | **yes**, through readiness (the DG blockers are typed C1a findings) |
| Offline package | **no**: `preDepartureCache` takes a `dangerousGoods` list as input and is not wired to a procedure on `main` (P1.5); when it is, it should read the same determination (RI-9) |
