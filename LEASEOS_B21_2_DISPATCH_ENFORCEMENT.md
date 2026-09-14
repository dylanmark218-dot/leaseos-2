# LeaseOS — v21.2 Checkpoint: Dispatch Enforcement on the Legacy Path

| | Previous | New |
|---|---|---|
| Version | v21.1 | **v21.2** |
| Tables | 173 | **174** (+1; `jobUnits`, `dispatchEligibilityChecks` extended) |
| Migrations | 37 | **38** |
| Procedures (role-authorized) | 205 | **207** |
| Bare `protectedProcedure` | 0 | **0** |
| Permissions | 157 | **158** |
| Sensitive permissions | 51 | **52** |
| Tests | 1,237 | **1,248** |
| Test files | 55 | **56** |
| Parity | 173/173 | **174/174 column-level** |
| CI gate | PASS | **PASS** |

Reserved slots 0016/0017 untouched.

---

## A correction first

v21.1 named `jobUnits.create` **and `transfers.create`** as the ungated
assignment paths. `transfers.create` records document delivery
acknowledgements — email, portal, API — and was never an assignment path. I
mislabelled it; the inventory said so too. Both are corrected. The single
ungated way to put a unit and operator on a job was `jobUnits.create`, and
that is what this tranche puts under the gate.

---

## Enforcement is a setting, and the setting is history

Gating the legacy path unconditionally would refuse every assignment until a
routing source and a verified HOS rule exist (P0, P9). So:

| Mode | The legacy path |
|---|---|
| **off** (default) | assigns as it always has |
| **advisory** | assigns; every assignment made without a readiness check, or against a blocked or unknown one, is an **exception the centre raises** — "this would have been refused if enforced" |
| **enforced** | assigns only on a fresh, fact-valid check whose blockers are resolved or covered by a granted override — **the award's rule** |

`dispatchEnforcementSettings` is append-only: *when* enforcement was on is
part of the audit trail. Every `jobUnits` row records the mode in force when
it was made and the check it relied on, so nothing has to be reconstructed
later. Scope is global today, because legacy jobs carry no company; an
entity-scoped row overrides global once they do. Changing the setting is
management or controller, sensitive, and needs a reason.

**`dispatchEligibilityChecks` can now be recorded for a direct job**, not
only a posting. A job-scoped check cannot be turned into a posting award —
`dispatch.award` refuses it by name and points at `jobUnits.create`.

---

## Two bugs the suite found

**Same-second tie.** `setAt` is a MySQL timestamp with second precision.
"Advisory, then enforced" written within one second tied on time, and the
"latest" row became whichever the database returned first — the end-to-end
test read *advisory* back after setting *enforced*. The engine breaks ties on
id and the query orders by it; the case is pinned in both orders.

**Persistent global state.** The first run's failure left the global setting
at *enforced* and the next run's first assertion assumed *off*. A test cannot
assume a global default it did not establish. It now sets *off* explicitly
first, and the history it asserts includes that row.

---

## The arc

Off → assigns, recorded as *off*, no check. Dispatcher may not change the
setting; management sets *advisory* with a reason. Advisory → assigns without
a check, and the exception centre raises `ungated:<id>` for it — and not for
the one made under *off*. Management sets *enforced*. Enforced → refused
*without a readiness check*; evaluated → **UNKNOWN**; refused *UNKNOWN* by
name; every unknown overridden by the right authority with a reason; assigned,
recorded as *enforced* with the check id, check marked used. The check for a
different job is refused before the mode is even consulted. The history reads
back *off, advisory, enforced*, each with its reason and its author. Teardown
returns to *off*.

---

## Files

**New:** `0039_dispatch_enforcement.sql` · `dispatchEnforcement.ts` ·
`dispatchEnforcementService.ts` · `dispatchEnforcement.test.ts` (11)

**Changed:** `routers.ts` (`jobUnits.create` gated) · `dispatchRouter.ts`
(+2 procedures; `evaluate` takes a posting *or* a job; `award` refuses
job-scoped checks) · `exceptionCentre.ts` / `surfacesService.ts` (new source)
· `recordsAuthorization.ts` (1 permission, sensitive, 2 mapped) · `schema.ts`
· drift guards · inventory (corrected)

---

## Rule 14, now

*Dispatch eligibility should be checked server-side. Return named blockers.*
Every reachable assignment path — the B12 award and the legacy direct
assignment — now runs through the same recorded, fingerprinted, overridable
check, or through a setting that says explicitly that it does not, with the
history of who chose that and why. A company that has loaded a routing source
and verified its HOS rule turns enforcement on without a code change.

---

## Genuine blockers — unchanged

**P0** — no routing source: every route is `route_not_evaluated`.
**AER ST37 / ST102 / Alberta 511** — inspection-only pending written permission.
**P9** — no verified rule: HOS unknown on every check; every seeded
requirement unverified.

---

## Exact next tranche

**IFTA on the fuel ledger.** The compliance document's selling point — the
worker scanning fuel receipts is also preparing the quarterly return.
Distance by jurisdiction with provenance (operator-stated until a routing
source exists), fuel by jurisdiction from `fuelTransactions`, the quarter
roll-up with receipts-matched and distance-reconciled percentages, and the
exceptions list — with the filing rule itself seeded unverified, as every
rule has been.
