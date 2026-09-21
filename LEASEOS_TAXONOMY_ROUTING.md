> **HISTORICAL — DO NOT USE AS CURRENT IMPLEMENTATION STATE.** This document describes an earlier plan. The implemented state is in `LEASEOS_CURRENT_STATE.md` (generated) and the per-release checkpoints.

# LeaseOS — Taxonomy & Routing Derivation (B12)

**Status:** engine built and tested (19 tests). Schema + migration 0011 written. Prototyped.
**Companion to:** `LEASEOS_BILLING_RECORDS_CHAIN.md` · `LEASEOS_BUILD_SPEC.md`

---

## 1. What this is not

It is not a list of job titles. A 300-entry dropdown of "vac truck driver / hydrovac operator /
winch tractor operator" would be a data-entry burden that improves nothing downstream.

**The taxonomy exists to make one classification decision propagate.** A dispatcher classifies the
work once, and the routing profile, permits, licence class, safety tickets, PPE, pre-trip items and
billing units all derive from it:

```
        service + truck + trailer + cargo + environment
                            │
        ┌───────────┬───────┼────────┬───────────┐
        ▼           ▼       ▼        ▼           ▼
     ROUTING     PERMITS  TICKETS  INSPECTION  BILLING
     PROFILE              & PPE     ITEMS      UNITS
```

Same principle as the trip record: information entered once propagates everywhere else.

---

## 2. Routing is the priority output

`deriveRoutingProfile()` produces exactly what the map engine needs:

| Output | Purpose |
|---|---|
| `axleGroups[]` with `loadedKg`, `exceedsRating` | Axle-by-axle evaluation against posted limits |
| `gvwKg`, envelope (L × W × H) | Bridge, clearance and corridor checks |
| `isOversize`, `isOverweight`, `requiresPermit` | Whether a permit conversation is needed |
| `restrictionLayers[]` | **Which map layers must be evaluated for this movement** |
| `unknowns[]`, `warnings[]` | What could not be established |

`restrictionLayers` is the interface to the map engine. Rather than the router checking everything
against everything, the classification tells it precisely what applies:

- Oilfield lease + gravel → `lease_access`, `turnaround_capability`, `gravel_surface`, `seasonal_road_ban`
- Hazardous cargo → `dangerous_goods`
- Over width → `width`, `oversize_corridor` — but **not** `height`, if height is within limits
- Urban → `school_zone`, `residential_sensitivity`

Swap produced water for crude oil in the same truck and the dangerous-goods layer appears, TDG
joins the endorsements, and placarding joins the pre-trip. Nobody edits three screens.

### Weight distribution is modelled, not measured

Cargo is distributed across load-bearing groups by rated capacity, with no cargo on the steer axle.
This is explicitly a **model used to decide what to check** — a real scale reading always
supersedes it. `exceedsRating` compares against the manufacturer rating, which is the physical
ceiling, not the legal one; the legal limit comes from the road segment.

---

## 3. The regulatory boundary

Every source document in this project has said the same thing: the system must not pretend an
AI-generated rule is law. That is now structural rather than aspirational.

Oversize/overweight triggers live in `regulatoryThresholds` — versioned rows carrying
`jurisdiction`, `source`, `effectiveDate`, `lastVerified`, `confidence` and `supersededAt`.
Defaults ship as:

```
jurisdiction: "UNCONFIGURED"
source: "Placeholder — not confirmed against any issuing authority"
confidence: "unverified"
```

An unverified threshold makes the routing engine **emit a warning on every profile it produces**,
and there is a test asserting that warning disappears only once confidence reaches
`authority_confirmed`. A stale table is visible as stale rather than quietly authoritative.

Three further boundaries, all tested:

- TDG output carries the note *"requirements must be confirmed against current regulations, not
  assumed from this list."*
- Permit output states *"permit conditions override routing recommendations."*
- Interprovincial work raises *"federal hours-of-service rules may apply instead of provincial —
  confirm the regime"* rather than picking one.

The engine decides **which rules must be checked**. It never decides that a movement is lawful.

---

## 4. Twelve dimensions, not one dropdown

`service · truck · trailer · cargo · environment · radius · load method · unload method ·
regulatory · qualifications · documents · billing`

Combining independent dimensions is what lets one classification express
*"Class 1 / Super-B / oilfield pipe / Alberta–Saskatchewan / regional / oversize / TDG /
permit-required / home weekly"* without anyone hard-coding that combination.

**The taxonomy is data, not code.** `taxonomyEntries` holds the codes; `taxonomy.ts` holds only the
derivation logic. Adding "hot oiler" or "coil tubing transport" is a row, not a deployment.
`TRUCKS`, `TRAILERS` and `CARGO` in the module are representative seeds for that table.

---

## 5. Derived requirements

| Derived from | Produces |
|---|---|
| Trailer present | Licence class (1/A vs 3/D) |
| Non-steer axle groups | Air brake endorsement |
| `cargo.hazardous` | TDG, shipping document, ERI, placarding, chemical gloves |
| Routing oversize/overweight | Permit type, permit copy in unit, escort assessment |
| Service category | Tickets, PPE, inspection additions, billing units |
| Environment | Site orientation, radio protocol, comms-coverage warning |
| Radius | Customs docs, hours-of-service regime question |
| `cargo.foodGrade` / `livestock` | Wash certificate / animal transport record |

Oilfield vacuum work, for instance, derives H2S Alive, Ground Disturbance, FR coveralls, gas
monitor, pump/PTO and tank-and-valve inspection items, and standby + per-load billing units — from
the classification alone.

---

## 6. Also completed this pass (B11)

**Disposal reconciliation** (`disposalReconciliation.ts`, 13 tests) — the gate between operations
and money. Answers whether each disposal is provable across 15 checks.

Two design decisions worth noting:

**Requirement-aware, not a blanket checklist.** Not every facility issues a scale ticket; not every
material needs a manifest. Each check declares whether it *applies* before whether it *passed*, and
`completenessPercent()` excludes `not_required` — so a facility that issues no ticket sits at 100%,
not permanently short. A checklist that shows false failures trains office staff to ignore the
screen.

**Partial hold.** A missing facility ticket holds the disposal charge only. `otherChargesMayProceed`
is typed `true` — structurally, not by convention. Same principle as per-line field ticket
acceptance: one gap must never freeze an entire invoice.

**Verification is never inferred from completeness.** A record with every field populated but
`verificationStatus: needs_review` is still held, with `missing: []` and the explanation
*"awaiting human verification"* — so office staff aren't hunting for a gap that doesn't exist.

**Billing entries reference, they don't copy.** `billingBookEntries` holds foreign keys to the
field ticket line, trip, load and disposal ticket — no duplicated quantities. Copying is what makes
a billing table disagree with the disposal ticket it came from.

**`billingSnapshots`** is the one deliberate exception: taken at invoice finalisation with
`sourceFactsJson`, `calculatedLinesJson`, `rateCardVersion` and a `payloadHash`, so *"why did we
bill $X?"* is answerable years later even after the operational records have moved on.

**`customerBillingConfigs`** resolves the open sub-question: default ticket scope, allowed
overrides, signature policy, partial acceptance, required fields and portal are **per-customer
configuration**. The driver isn't making a business-policy decision at a lease at 6am — LeaseOS
presents that customer's normal workflow, with override where the actual service differs.

---

## 7. Status

| Engine | Tests |
|---|---|
| `geofence.ts` | 10 |
| `tracking.ts` | 18 |
| `billing.ts` | 15 |
| `fieldTicket.ts` | 19 |
| `disposalReconciliation.ts` | 13 |
| `taxonomy.ts` | 19 |
| **Total** | **94** |

53 tables · 12 migrations · 31 prototype screens.

---

## 8. Next — B13: map engine consumes the profile

The routing profile now exists but nothing consumes it. B13 closes that loop:

1. `roadSegments` table with the attributes each `RestrictionLayer` evaluates
2. `bridges` table where `unknown` is a state distinct from `clear`
3. Segment evaluation: routing profile × segment attributes → pass / review / blocked / unknown
4. Route scoring with per-input explanation — never an opaque number
5. Route data confidence, surfacing stale and missing sources
6. `permits` as first-class objects, re-evaluated when truck, load or route changes
7. Seed `regulatoryThresholds` with authority-confirmed values per jurisdiction

**Item 7 gates the rest.** Until real thresholds are loaded, every profile carries an unverified
warning — which is correct behaviour, and also means the routing output can't be trusted for
dispatch yet. That's the first call to make: get confirmed oversize/overweight triggers for each
jurisdiction you operate in, with a date and a source.
