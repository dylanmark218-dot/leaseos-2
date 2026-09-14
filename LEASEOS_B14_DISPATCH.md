# LeaseOS — B14: Dispatch Operations Centre

**Status:** engines built and tested. **198 tests across 11 engines**, all green.
**Companion to:** `LEASEOS_B13_DATA_GOVERNANCE.md` · `LEASEOS_B12_ROUTING_EVIDENCE.md`

---

## 1. The architecture rule, made structural

The spec's closing rule is the whole design:

> MATCH — this operator/equipment appears suitable
> BID / INTEREST — the operator is willing to take the job
> DISPATCH ELIGIBILITY — the safety/regulatory/readiness gate allows assignment
>
> **A positive match or accepted bid must never automatically imply dispatch eligibility.**

Enforced by making the two engines return incompatible shapes:

| | `matchOperatorToJob()` | `evaluateDispatchReadiness()` |
|---|---|---|
| Returns | `score: number`, `matched: boolean` | `verdict: eligible \| eligible_review \| blocked \| unknown` |
| Purpose | Visibility + suggestion | Assignment permission |
| Has a score? | Yes | **No — deliberately** |

There is no arithmetic converting one into the other, and a test asserts a `MatchResult` carries
neither `verdict` nor `eligible`. Every match explanation ends with *"This is a suitability match
only — dispatch eligibility is evaluated separately."*

In the prototype's bid comparison, D. Reid scores highest at 86 **and is still not assignable**.
That's the rule working.

---

## 2. Emergency cannot bypass safety

The spec says emergency must never become *"ignore inspection, qualification, HOS or
dangerous-goods requirements."*

`evaluateDispatchReadiness()` **has no priority parameter.** Urgency is structurally unable to
reach the gate — there is no argument to pass it through. `dispatchPostings.priority` affects
notification urgency and queue ordering only.

There's a test that spreads a `priority: "emergency"` field onto the input and confirms an open
critical defect still returns `blocked`.

---

## 3. Non-overridable blockers

The spec mentions "override attempts" and "actual authorized overrides" in the audit trail but
doesn't say which blockers may be overridden. That distinction matters enough to specify, so I
added it.

**Cannot be overridden by any role, including administrator:**

expired licence · expired credential · expired inspection · expired registration · expired
insurance · open critical defect · missing mechanic release · insufficient HOS · incomplete
classification · missing TDG document · missing permit · missing ERP for DG · destination refuses
the material · incompatible trailer · route evaluated as blocked

**Overridable with a named reason, manager or above:**

unverified destination acceptance · missing non-critical documents · maintenance overdue ·
unverified jurisdiction data · route review · unknown credential expiry

`requestOverride()` refuses a non-overridable blocker with:

> *Cannot be overridden by any role. The underlying condition must be resolved.*

An expired inspection isn't a judgement call a manager gets to make. **Refused attempts are still
recorded** — a refused attempt to dispatch a unit with an open critical defect is exactly what an
auditor needs to see.

---

## 4. Freshness at award

A bid submitted three hours ago was gated against conditions that may have changed since — a
licence can expire at midnight between bid and award.

`requiresReEvaluation()` reports the age of the last check and demands a re-run past 30 minutes.
`dispatchEligibilityChecks.usedForAward` marks which check actually authorised an assignment, so
the record shows what was true at the moment of the decision, not at bid time.

---

## 5. Unknown outranks review

Consistent with B12: `deriveVerdict()` puts `unknown` **above** `review` in precedence. An
unevaluated condition is not a known-minor one, and cannot resolve to eligible by default.

Unreported HOS returns `unknown`, not `eligible_review`. A credential present but with no recorded
expiry returns `unknown`, not `eligible`.

---

## 6. Visibility filtering

> Operators should only see jobs for which they are potentially qualified.

`filterVisiblePostings()` runs the match and hides non-matching postings. Both a signal-to-noise
measure and a safety one — a heavy-haul assignment shouldn't appear to someone whose profile can't
satisfy its basic requirements.

Filtering is on *match*, not eligibility. Potentially qualified means "may see and bid". Assignable
is a separate question answered later.

---

## 7. Explained matching, never an opaque score

> Do not create an unexplained AI ranking. If LeaseOS recommends a candidate, explain why.

Every `MatchReason` carries factor, outcome, detail and **points contributed**, so the arithmetic
is inspectable:

> Suggested because TDG certification (current), H2S Alive (current), Specialty pool
> (vacuum_fluid), Equipment class (tri_drive_vac), Tank capacity (16,000 L), Pump (fitted),
> Distance from origin (31 km).

Soft factors — region, distance, on-call, availability, preferred capabilities — contribute points
but never disqualify. Hard requirements — required credentials, specialty pool, equipment class,
DG compatibility, minimum capacity — disqualify and set the score to 0.

**Unrecorded is not sufficient.** A unit with no recorded tank capacity returns `unknown` for that
factor and lists "Tank capacity unknown" in missing requirements, rather than being assumed
adequate.

**Experience is not a credential.** `Capability.isCredential` separates "has done rig moves before"
from "holds current TDG certification". Experience aids matching and must never be presented as a
regulatory credential.

---

## 8. Resource conflicts

`detectBookingConflicts()` uses half-open intervals — a job ending at 16:00 does not conflict with
one starting at 16:00, so legitimate back-to-back work isn't flagged. Genuine overlap produces the
message the spec asks for:

> VAC-27 is assigned to JOB-8841 until 16:00 and is also proposed for JOB-8850 at 14:00

Also tested: a job doesn't conflict with itself on re-save, and different resources don't
cross-report.

---

## 9. Schema — 13 tables

| Table | Purpose |
|---|---|
| `specialtyPools` | Configurable, not hard-coded services |
| `operatorCapabilities` | With `isCredential` and `expiresAt` |
| `operatorAvailability` | Declared state, region, radius, preferences |
| `onCallRotations` | Position, window, call/response tracking |
| `dispatchPostings` | Distribution mode, planning state, priority |
| `dispatchRoles` | Multi-unit crews — each role assigned independently |
| `dispatchInvitations` | sent → delivered → viewed → responded |
| `dispatchBids` | Willingness, with a match snapshot |
| `dispatchEligibilityChecks` | The gate result, timestamped, `usedForAward` |
| `dispatchOverrides` | Granted **and refused**, with reasons |
| `dispatchAuditEvents` | Assignment history — never silently replaced |
| `resourceBookings` | Conflict detection source |
| `dispatchTemplates` | Recurring/standing work |

**71 tables · 14 migrations**, schema/migration parity verified.

A rig move fits without special-casing: one posting, roles for lead, two winch tractors, bed truck,
picker, lowboy and two pilot vehicles, each with its own equipment requirement and its own
eligibility check.

---

## 10. Still to build

1. `db.ts` + tRPC routers for postings, bids, invitations, eligibility, overrides
2. Dispatch map — active units, available operators, jobs, restrictions (needs B13 road graph)
3. Notifications and delivery tracking
4. Recurring work generation from templates
5. Subcontractor/external carrier onboarding
6. Rate visibility as a permission, not just a boolean

**Prototype:** 35 screens — Dispatch board, Invitations & bids, On call, 7-day schedule added.

---

## 11. Status

| Engine | Tests |
|---|---|
| geofence · tracking · billing · fieldTicket · disposalReconciliation · taxonomy | 94 |
| routingCompiler · routeEvaluation | 37 |
| dataIngestion | 25 |
| **dispatchMatching · dispatchReadiness** | **42** |
| **Total** | **198** |

Typecheck: 1 pre-existing error (`TripOperationsWorkspace.tsx(77,846)`, Phase 0 item 3, untouched).
Branch reconciliation still needs the Integrated Operations ZIP — nothing here touches those files.
