# LeaseOS — v21.1 Checkpoint: The Dispatch Gate, Reachable

| | Previous | New |
|---|---|---|
| Version | v21.0 | **v21.1** |
| Tables | 173 | **173** — no schema change |
| Migrations | 37 | **37** |
| Procedures (role-authorized) | 199 | **205** |
| Bare `protectedProcedure` | 0 | **0** |
| Permissions | 152 | **157** |
| Universal permissions | 7 | **8** |
| Sensitive permissions | 49 | **51** |
| Tests | 1,225 | **1,237** |
| Test files | 54 | **55** |
| Parity | 173/173 | **173/173** |
| CI gate | PASS | **PASS** |

Reserved slots 0016/0017 untouched.

---

## What was found

The master directive's rule 14 — *dispatch must be server-enforced; return
named blockers* — was built and unreachable.

B12 designed the gate correctly: `evaluateDispatchReadiness` with named
blockers of severity `blocking | review | unknown`, each either overridable
by a named authority or overridable by no one; `dispatchEligibilityChecks`
recording verdict, blockers, a fingerprint of the facts seen, evaluator and
`usedForAward`; `dispatchOverrides`; and `awardAssignment`, which recomputes
the facts and refuses an award when they changed or the check aged out.

**Nothing wrote the check table. No procedure reached the award.** The whole
marketplace — postings, bids, overrides, award — was engine + tables + tests
with no API. Meanwhile the two assignment paths that *were* reachable,
`jobUnits.create` and `transfers.create`, assigned on `dispatch.assign` with
no gate at all.

---

## What was built

**`readinessComposer.ts`** answers *"Can Unit 142 take this job tomorrow?"*
by gathering every engine's finding server-side — the caller supplies
identities and nothing else — into the input B12 evaluates and the fact set
B12 fingerprints:

| Engine | Contribution |
|---|---|
| Compliance passport | licence, TDG for dangerous goods, medical fitness **as a projection** — `eligible: yes/no/unknown` and nothing more |
| Insurance gate | the six statuses in B12's vocabulary: policy expired → blocking, no policy → blocking, proof missing → review, reported-not-verified → review |
| Maintenance / mechanic release | critical defect unreleased → blocking; a release after the report lifts it |
| Roadside | open event → blocking, overridable by no one |
| Calibration | uncalibrated billing device → review; dispatch is not stopped, billing is |
| Field device | revoked → review |
| Routing | **`route_not_evaluated` — unknown, overridable by a manager** — because no routing data source is loaded |

The legacy flat licence field on `operators` is read as a weak signal when no
structured credential exists, and says so in the contributions.

**`dispatchRouter.ts`** — six procedures make the gate the way to dispatch:
`readiness` (preview, no write), `evaluate` (records the check), `overrideRequest`
(recorded and refused on a non-overridable blocker, never silently dropped),
`overrideGrant` (answers a request; never the requester; B12's authority
ladder), `award` (facts recomputed here, never accepted from the caller), and
`whatAmIMissing` — the AI Secretary's answer, the operator's own checklist,
self-scoped, nothing private on it.

---

## A latent B12 bug, found the moment the gate was wired

B12's readiness engine marks `route_not_evaluated` as *unknown, overridable by
a manager*. B12's award decision refused every unknown verdict
**unconditionally** and consulted overrides only for *review* blockers. The
override the engine offered was dead: with no routing data — which is every
job today — nothing could ever be awarded, manager or not. It also skipped
review blockers entirely whenever the verdict was unknown.

Fixed: a granted override on an *overridable* unknown blocker covers it, as
for review — a recorded human decision with a reason is not a rounding-up.
An unknown blocker nobody may override still refuses regardless, and review
blockers are checked whenever the verdict is unknown or review. B12's own 51
tests still pass; the existing "an accepted bid does not resolve unknown" holds
because no override was granted in it.

**One error of my own, caught on review:** I first mapped *no policy on
record* to an overridable unknown. The insurance engine's own effect for that
status is `blocked`; an uninsured truck is not something a manager overrides.
Now blocking, non-overridable.

---

## The arc, in one line each

Held unit → **BLOCKED**, defect named, route unknown alongside, insurance
verified in the contributions. Award on the check → refused by name. Override
request on the defect → recorded, refused: *overridable by no one*. Mechanic
releases → award on the *old* check refused: *facts changed, re-evaluate*.
Re-evaluate → **UNKNOWN**, no blocking items. Dispatcher requests the route
override; may not grant their own; a second dispatcher lacks manager
authority; the manager grants. Award → **still refused**, naming HOS state
unknown, availability undeclared, destination acceptance unverified, medical
unverified — one override is not dispatch. Each requested and granted by the
right authority with a reason on record. Award → **proceeds**; check marked
used; every override on it granted. The operator asks what they are missing
and gets their own list with nothing private on it; a user with no operator
record gets an honest note, not someone else's readiness.

An uninsured truck with an open roadside event → blocked twice, neither
overridable.

---

## Honest state of the gate

With no routing data and no verified HOS rule (P0, P9), **every job today
reaches UNKNOWN and dispatches only through recorded manager overrides**.
That is the correct behaviour of a system that does not know, and every such
dispatch now leaves a named reason by a named person on a check that can be
read later. It is not a convenience; it is the audit trail rule 14 asked for.

**The legacy paths remain ungated.** `jobUnits.create` and `transfers.create`
still assign without a check. Gating them today would refuse every assignment
until P9, and they carry existing behaviour and tests. They are named here as
the remaining gap, not hidden. The migration path is: route them through
`dispatch.evaluate` + `award` once a routing source and one verified HOS rule
exist, then retire them.

---

## Files

**New:** `readinessComposer.ts` · `dispatchRouter.ts` (6 procedures) ·
`dispatchGate.test.ts` (11)

**Changed:** `dispatchAward.ts` (unknown-override fix) ·
`recordsAuthorization.ts` (5 permissions, 1 universal, 2 sensitive, 6 mapped)
· `routers.ts` · drift guards · `ci-gate.sh` · inventory · `surfaces.test.ts`
(assertion widened to the surface's actual promise)

---

## Genuine blockers — unchanged, and now visible in every verdict

**P0** — no routing source: every route is `route_not_evaluated`.
**AER ST37 / ST102 / Alberta 511** — inspection-only pending written permission.
**P9** — no verified rule: HOS is unknown on every check; medical, abstract and
every compliance requirement remain unverified.

---

## Exact next tranche

Two candidates of equal weight; the choice is Dylan's.

**Legacy gate migration** — route `jobUnits.create` and `transfers.create`
through the gate behind a company setting that defaults off, so a company
that has loaded a routing source and verified its HOS rule can turn
enforcement on without a code change, and the exception centre raises
*"assignment made without a readiness check"* for every ungated one.

**IFTA on the fuel ledger** — the compliance document's selling point: the
worker scanning fuel receipts is also preparing the quarterly return. Distance
by jurisdiction with provenance (operator-stated until a routing source
exists), fuel by jurisdiction from `fuelTransactions`, the quarter roll-up
with receipts-matched and distance-reconciled percentages, and an exceptions
list — with the filing rule itself seeded unverified.
