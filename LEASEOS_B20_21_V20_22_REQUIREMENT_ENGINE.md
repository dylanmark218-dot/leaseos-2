# LeaseOS — v20.22 Checkpoint: Generalized Requirement Engine + Packs + Calibration

| | Previous | New |
|---|---|---|
| Version | v20.21 | **v20.22** |
| Tables | 158 | **164** (+6; `complianceRequirements`, `loads`, `disposalTickets` extended) |
| Migrations | 35 | **36** |
| Procedures (role-authorized) | 176 | **182** |
| Bare `protectedProcedure` | 0 | **0** |
| Permissions | 133 | **138** |
| Sensitive permissions | 44 | **46** |
| Tests | 1,155 | **1,179** |
| Test files | 51 | **52** |
| Parity | 158/158 column-level | **164/164 column-level** |
| CI gate | PASS | **PASS** |

Reserved slots 0016/0017 untouched.

---

## The document's strongest addition, built

*WHO + WHAT EQUIPMENT + WHAT ATTACHMENTS + WHAT WORK + WHERE + WHEN + WHAT
CARGO + WHAT CUSTOMER + WHAT JURISDICTION = WHAT IS REQUIRED.*

v20.21 evaluated a requirement against one subject. `requirementEngine.ts`
evaluates a **work context** — the whole combination. Each participant gets
its own passport; then `work_context` requirements are evaluated against the
flattened combination (`equipment.poweredMobile`, `attachmentTypes`,
`workType`, `dangerousGoods`, `customerRef`…) with the union of credentials
on hand. Worst wins; unknown does not round up; a credentialed worker on an
inspected excavator doing excavation is **authorized**, and the same worker
doing **ground disturbance** without a utility locate is **blocked**.

**Packs.** A hydrovac company and a crane company run the same core and
receive different rules. `packsActivatedBy` reads the company profile:
`activities: ["hydrovac"]` activates powered mobile equipment, confined
space, ground disturbance and billing-device calibration — and *not* lifting
devices or pressure equipment. A pack's requirement is invisible to a company
that has not activated it: the same ground-disturbance job is **authorized**
for a company without the pack, because the rule is not in force for them.
Core requirements have no pack and always apply.

**Customer requirements are separate from the law.** A customer's site
orientation missing from the record is `review`, reasoned as "customer:
requires…", never confused with a statutory item.

Every pack requirement — powered mobile equipment, lifting logbooks and load
charts, ABSA permits and relief devices, confined-space permits, utility
locates — is seeded **unverified**, and a fully credentialed context on the
seeds is **unknown**.

---

## Trained, competent, familiar with the instructions, employer-authorized

"Joe is an equipment operator" is not a fact LeaseOS holds. The OHS rule
names four elements; `operatorEquipmentAuthorizations` records four evidence
fields, and authorization is their conjunction. Missing any one is
**blocked**, with the reason naming which. Per exact equipment type — a skid
steer does not authorize an excavator. Per attachment — a bucket does not
authorize a personnel basket. The employer's authorization is the API call,
by the safety or management user who made it — but it is stored `pending`
until training, competency and acknowledgement are all on record.

---

## Calibration: one expiry, different consequences

A scale's calibration state is derived from its event history; a failure or
out-of-tolerance finding **voids** the last calibration until the device is
returned to service. What the state *means* depends on what the number is
for:

| Use | Expired calibration |
|---|---|
| Billing | **hold** |
| Weight compliance | **cannot certify** |
| Dispatch availability | review — the truck may still move |
| Safety reading | review; **hold** on a failure |

**"Which records depended on it?"** — answerable now, because `loads` and
`disposalTickets` gained `measurementDeviceId`. That is the provenance link
the typed-commit receipts have been preserving toward since B20.3. A failure
finding is refused unless it says `suspectFrom` — the device was usually
wrong before anyone noticed — and the impact window runs from there to the
finding or return-to-service. The end-to-end test registers a scale, weighs
three loads on it, finds it +2.4% out, and gets back exactly the two loads
inside the window with their invoice and billing book — and not the one
before.

---

## A real engine bug, found by the new suite

A pre-use inspection with twelve hours left floored to 0 days, and a warn
window of 0 read `0 <= 0` as "expiring" — every valid daily inspection would
have raised a review. A 24-hour item is valid or it is not. Zero now means
*never warn*, and the edge is pinned in the passport suite where it belongs.

---

## Families the engine can now host, deferred as packs

Logbooks, pressure equipment's full model, LOTO, confined-space permit
workflow, ground-disturbance packages, first aid readiness, PPE assets,
hearing conservation, fall protection, COR readiness, environmental ledger,
recalls, tooling, modifications, the digital twin. Each is a rule pack and
its forms; none needs the application rebuilt. That is what the document
said the engine would buy, and it is what it buys.

---

## Files

**New:** `0037_requirement_engine_packs_calibration.sql` · `requirementEngine.ts`
· `requirementRouter.ts` (6 procedures) · `requirementEngine.test.ts` (22)

**Changed:** `compliancePassport.ts` (subject types, packKey, zero-warn fix)
· `complianceRequirementSeeds.ts` (7 packs, 10 requirements) ·
`compliancePassport.test.ts` (+1) · `recordsAuthorization.ts` (5 permissions,
2 sensitive, 6 mapped) · `routers.ts` · `schema.ts` · drift guards ·
`ci-gate.sh` · inventory

---

## Genuine blockers

**P0** — Spatial, LoadSense, Integrated Operations source never supplied.
**AER ST37 / ST102 / Alberta 511** — inspection-only pending written permission.
**P9** — thirty-two compliance requirements across four packs now await
verification. Every passport and every work authorization on the seeds is
UNKNOWN, correctly.

---

## Exact next tranche

**v20.23 — Insurance & Risk, on the registry and the engine.** It has been
next since v20.20 and now has everything it needs underneath: the six-status
ladder, the pack mechanism, evidence relationships for one-policy-many-units,
and the roadside allowlist. Policies → coverages → covered entities; COI
requirement profiles as customer requirements the engine already knows how to
hold separate from the law; claims linked to incidents with insurance
receivable kept apart from the repair expense; Roadside Document Mode.
