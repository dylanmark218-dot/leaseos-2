# Fleet & Equipment Portfolio — asset core checkpoint (2026-10-01)

Branch `claude/fleet-equipment-portfolio-design-3d13d5`. Two commits:

1. **`82df3d6` — the foundation, carried onto today's main.** The foundation slice built on this
   design by the mechanic-portal branch (`unitHolds`, the meter ledger and its read-in-place union,
   `fleetPortfolioEvents`, the composer's hold reads, mechanic portal CP1 and the CP1.5 unit-scope
   security work, migrations `0199`–`0201`) had frozen a week earlier, 199 commits behind `main`, with
   no pull request. It is merged here onto `main` `b35bac4`; eighteen files conflicted and every
   resolution is in that commit's message. One wording rule came out of it: F1's finance-scope
   `requireUnit` now refuses in CP1.5's words, so another organization's unit and a missing unit are
   indistinguishable through either helper, and three procedures check the unit before the book.
2. **This checkpoint — the asset core.** What the foundation's reconciliation deferred as R-7:
   identity and lifecycle on `units`, components, the fleet list and the asset detail (API and
   screen), the unit-side readiness answer, and the driver's own assigned units.

Design: `docs/fleet/FLEET_EQUIPMENT_PORTFOLIO_SURVEY_AND_DESIGN.md` (§A.14, §B.2–B.5, §B.13).
Foundation: `docs/fleet/FLEET_PORTFOLIO_FOUNDATION_CHECKPOINT.md`,
`docs/fleet/FLEET_PORTFOLIO_FOUNDATION_RECONCILIATION.md`.

## Counts

| | `main` `b35bac4` | + foundation (`82df3d6`) | + this checkpoint |
|---|---|---|---|
| Tables | 440 | 443 | **444** (`unitComponents`) |
| Migrations | 190 | 193 | **195** (`0221_fleet_asset_identity.sql`, `0222_fleet_component_guards.sql`) |
| Role-authorized procedures | 743 | 755 | **765** (+10, `server/fleetAssetRouter.ts`, spread into `fleet`) |
| Operational procedure map | 723 | 735 | **745** |
| Mounted server paths | 793 | 805 | **815** |
| Permissions | 384 | 388 | **392** |
| Sensitive (fail-closed) | 143 | 146 | **149** |
| Universal (self-scoped) | 13 | 13 | **14** (`fleet.read_own`) |
| Classification | `c1a.3` | `c1a.4` | **`c1a.5`** |
| Unwired `_core` engines | — | unchanged | **unchanged** — `fleetAssets` is reached from its router |

Every count is read from the source by `scripts/current-state.sh`.

## Migrations — 0221 and 0222

Scanned at commit time across `origin/main` and every remote branch: `main` ends at `0219`
(customer, contract and rate management, #98); the highest claim on any branch is `0220`
(`claude/eld-compliance-intelligence-ramlrd`, taken while this checkpoint was being gated — the first
scan had found `0220` free). `0221` and `0222` are the first two numbers free everywhere. Recorded in `docs/architecture/MIGRATION_COLLISION_REGISTER.md`.

- **`0221`** — additive columns on `units`: `assetClass` (enum, NULL = not classified), `assetType`,
  `assetSubtype`, `companyAssetNumber`, `serialNumber`, `plateJurisdiction`, `make`, `model`,
  `modelYear`, `manufacturer`, `ownershipType`, `acquiredAt`, `homeTerminal`, `assignedBranchRef`,
  `assignedDivision`, `defaultOperatorId`, `regulatoryClass`, `lifecycleStatus` (default `active`),
  `lifecycleChangedAt`, `lifecycleChangedByUserId`, `lifecycleReason`, `retiredAt`, `notes`; index
  `(lifecycleStatus, assetClass)`. New table `unitComponents` (parent, child, relationship,
  removable, installed/removed with actors and work orders). No existing value changes meaning:
  `vehicleType` stays, and every existing unit reads `lifecycleStatus = active`, unclassified.
- **`0222`** — triggers: a component installation is never edited and never deleted, and a detached
  relation is never changed again; a lifecycle change must carry its own actor, time and reason
  (a raw `UPDATE units SET lifecycleStatus` is refused).

## What is canonical now

| Concept | Canonical | Rule |
|---|---|---|
| Asset identity | `units` + `shared/fleetAssetTypes.ts` | the class is derived from the type; the legacy `vehicleType` is derived from the type for new rows; an unclassified unit is reported as such, never guessed |
| Lifecycle | `units.lifecycleStatus`, written only by `fleet.lifecycleSet` | stored; transitions are recorded acts with a reason, conditional on the status the caller saw; `retired`/`sold` are left only by management; `transferred` is refused (O-4); a person's act (`HUMAN_AUTHORIZATION_PERMISSIONS`) |
| Components | `unitComponents` via `fleet.componentAttach` / `componentDetach` | both ends are units; a power unit or a trailer is never a child; one place at a time (locked under the transaction); no cycles; detachment is history |
| Operational state | `_core/fleetPortfolio.ts operationalState` | now reads lifecycle (out of the fleet → `out_of_service`; storage → `maintenance_hold`) and components (a child's critical defect or safety hold holds the parent, O-9); `lifecycle` left `NOT_EVALUATED` |
| Dispatch | `composeReadiness`, unchanged authority | reads lifecycle, class and components for the unit and the trailer; new codes classified: `(unit|trailer)_(retired|sold|transferred)` HARD, `(unit|trailer)_in_storage` APPROVED_POLICY_ONLY, `(unit|trailer)_class_mismatch` HARD, `component_(critical_defect|hold_safety):<childId>` HARD; all three join the unit's and the trailer's fingerprint versions |
| Unit-side readiness | `fleet.unitReadiness` → `fleetAssetService.unitSideReadiness` | the portfolio's reasons plus lifecycle, components, the required documents and insurance, through the composer's own loaders (`credentialsFor`, `credentialState`, `policiesCovering`, `holdBlocker`, now exported) and the one classification; it names the three axes it does not evaluate and its `clear` is not a dispatch verdict |
| The driver's own units | `fleet.myAssignedUnits` (`fleet.read_own`, universal, self-scoped) | the units and trailers bound to the caller's operator in a live slot — the slot model is the one source of "assigned"; no unit id is taken from the driver; the answer carries `validUntil` for the phone |

## Procedures and permissions

| Procedure | Permission | Sensitive |
|---|---|---|
| `fleet.list`, `fleet.get`, `fleet.unitReadiness`, `fleet.components` | `fleet.read` | no |
| `fleet.assetCreate`, `fleet.assetUpdate` | **`fleet.asset.manage`** (shop lead, office, management) | **yes** |
| `fleet.lifecycleSet` | **`fleet.lifecycle.set`** (shop lead, management; return from retired/sold: management) | **yes**; never an agent's |
| `fleet.componentAttach`, `fleet.componentDetach` | **`fleet.component.manage`** (mechanic, shop lead, management) | **yes** |
| `fleet.myAssignedUnits` | `fleet.read_own` (universal, self-scoped) | no |

Every procedure resolves the acting organization and answers NOT_FOUND for another organization's
unit, relation or reading, in the words a missing unit gets. The `fleet.list` cap is 100 and is
stated in the answer; each row's state is a full read of its sources.

## The screens

`/fleet` is now the authoritative Fleet surface — the portal shell's **Fleet** panel
(`client/src/portal/panels/FleetPanel.tsx`, registered in the panel contract for the fleet, dispatch,
safety, office and management portals), and `/fleet/:unitId` (and the deep link the server already
emitted, `/portal/:portal/units/:unitId`) is the asset detail
(`client/src/fleet/FleetAssetDetail.tsx` + `FleetAssetDetailView.tsx`): header, unit-side readiness
labelled as not a dispatch verdict, state and reasons with the act that lifts each, identity,
lifecycle (with the recorded change), holds (place / release), usage, and the Maintenance,
Inspections, Defects, Documents, Equipment and History tabs. Controls are offered and withdrawn on
FORBIDDEN with the server's reason. `fleetPresentation.ts` is the one mapping from server status to
word; an unrecognised status reads "Unavailable", never "Operational". Both views run through the
axe rules in the accessibility suite in seven states. The former demonstration stays under
`/showcase/fleet`.

## Tests

| File | Cases | What it proves |
|---|---|---|
| `server/_core/fleetAssets.test.ts` | 10 | the vocabulary; lifecycle transitions and who may make them; lifecycle and class blockers; component attachment rules (self, class, out-of-fleet, double attachment, cycles) and the O-9 roll-up; the unit-side verdict order |
| `server/fleetAssetCore.db.test.ts` | 13 | through the real router, composer and triggers: create/edit with events and the derived class; a legacy unit reads unclassified; storage and retirement in the composer with their classes and the moving fingerprint; management-only reactivation; `expectedFrom` conflict; two lifecycle writers racing (one wins); the actor trigger; a component's critical defect holding the truck until detached, the history kept and unrewritable; two attachments racing (one lands); class mismatch on the slot both ways, and no guess for an unclassified unit; unit-side readiness with its three unevaluated axes; the list with filters and the cap; the driver's own units from the slot model; the organization boundary on seven procedures |
| `client/src/fleet/*.dom.test.tsx` | 11 | the presentation contract; the list's ordering, words and empty answer; the detail's reasons, refused controls, lifecycle form and unrecognised state |
| `client/src/a11y/a11y.dom.test.tsx` | +21 | seven Fleet states at three viewports |
| existing pins | — | `fleetPortfolio.test.ts` updated (lifecycle is evaluated now); census, path and inventory pins moved by exactly this checkpoint's deltas |

## Known gaps, named

- `fleet.unitReadiness` reads the same records the composer reads through the composer's own
  helpers and classification, but it is still a second assembly of them. Making `composeReadiness`
  answer with no operator (its operator axes `NOT_EVALUATED(not_applicable)`) is the generalisation
  the roadmap asks for and remains open.
- Drivers hold `fleet.read` (owner decision O-7, narrowing it to assigned units, is open), so a driver
  may read any unit of their organization by id; they may change none.
- The list derives each row's state with a full read of its sources: at most 100 rows, stated.
- `transferred` is in the lifecycle enum and refused until an ownership history exists (O-4).
- Slot `requiredEquipmentClass` / `requiredTrailerClass` are still not compared against
  `assetType`; the vocabulary is in place for the next checkpoint (inspections and defects) to do it.

## Gate

`DATABASE_URL=… bash scripts/ci-gate.sh` from a dropped and recreated MariaDB 10.11 on Node 22.23.3
(`.nvmrc`), recorded in the commit that carries this document.
