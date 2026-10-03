# Fleet & Equipment Portfolio — asset core checkpoint (2026-10-01, merged onto main 2026-10-03)

Branch `claude/fleet-equipment-portfolio-design-3d13d5`. Four steps:

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
3. **`main` `240b2dd` merged in while the asset core was being gated** (#108, the AI sales
   architecture; Sign & Attest SA1; the company board and open-work offers, `0205`/`0206`,
   `0214`–`0216`). Nine files conflicted, all of them pins and registers: the permission union, grants,
   universal list and procedure map take both sides; the portal shell draws main's Board tab and the
   Fleet tab; the authorization, path and inventory pins are main's plus this branch's 22. One
   security finding came out of it: CP1.5's structural guard (`server/unitScopeGuard.test.ts`)
   caught main's new `shifts.post` and `shifts.award` writing a unit id they never checked; both now
   call `requireUnitInScope`, and `shifts.post` joined the refusal table in
   `server/unitScopeSecurity.db.test.ts`.
4. **`main` `2864723` merged in (2026-10-03).** Main had since merged the foundation itself (the
   mechanic-portal branch's `0199`–`0201`, CP1.5), mechanic portal CP2 (`0221`/`0222`, defect to
   return to service), payroll P1/P2, the Safety & Compliance Program Builder, the driver portfolio
   and the external source registry. Twenty-one files conflicted. Every foundation file takes
   main's version: main's own CP1.5 fixes for `shifts.post`/`shifts.award` supersede step 3's, and
   step 1's edits to the finance, purchasing, payroll and commercial-setup routers are dropped for
   main's (step 1 had lost main's unit check on `roadside.open`; main's version restores it).
   `drizzle/schema.ts` is main's plus the asset core's columns and `unitComponents`. The asset
   core's migrations moved to `0237`/`0238`, and later to `0242`/`0243` (below). The classification version is `c1a.5` on
   main's `c1a.4`. Pins, grants, the procedure map and the human-authorization list take both sides.

Design: `docs/fleet/FLEET_EQUIPMENT_PORTFOLIO_SURVEY_AND_DESIGN.md` (§A.14, §B.2–B.5, §B.13).
Foundation: `docs/fleet/FLEET_PORTFOLIO_FOUNDATION_CHECKPOINT.md`,
`docs/fleet/FLEET_PORTFOLIO_FOUNDATION_RECONCILIATION.md`.

## Counts

| | `main` `2864723` | this branch, merged | delta |
|---|---|---|---|
| Tables | 482 | **483** | +1 (`unitComponents`) |
| Migrations | 207 | **209** | +2 (`0242_fleet_asset_identity.sql`, `0243_fleet_component_guards.sql`) |
| Role-authorized procedures | 897 | **907** | +10 (`server/fleetAssetRouter.ts`, spread into `fleet`) |
| Operational procedure map | 874 | **884** | +10 |
| Mounted server paths | 952 | **962** | +10 |
| Permissions | 436 | **440** | +4 |
| Sensitive (fail-closed) | 178 | **181** | +3 |
| Universal (self-scoped) | 21 | **22** | +1 (`fleet.read_own`) |
| Classification | `c1a.4` | **`c1a.5`** | four fleet rules |
| Unwired `_core` engines | — | unchanged | `fleetAssets` is reached from its router |

Every count is read from the source by `scripts/current-state.sh`. The delta is exactly the asset
core: the foundation is main's now.

## Migrations — 0242 and 0243

Drafted as `0220`; moved to `0221`/`0222` when `claude/eld-compliance-intelligence-ramlrd` took
`0220`; to `0237`/`0238` on merging `main` `2864723`, which had taken `0221`/`0222` for mechanic
portal CP2; and to `0242`/`0243` on merging `main` `d93eb13`, when the marketplace branches had
taken `0237`–`0240` and the safety program branch `0241`. `0242` and `0243` were the first two
numbers free on main and on every remote branch at the scan. No environment applied them under an
earlier number. Recorded in `docs/architecture/MIGRATION_COLLISION_REGISTER.md`.

- **`0242`** — additive columns on `units`: `assetClass` (enum, NULL = not classified), `assetType`,
  `assetSubtype`, `companyAssetNumber`, `serialNumber`, `plateJurisdiction`, `make`, `model`,
  `modelYear`, `manufacturer`, `ownershipType`, `acquiredAt`, `homeTerminal`, `assignedBranchRef`,
  `assignedDivision`, `defaultOperatorId`, `regulatoryClass`, `lifecycleStatus` (default `active`),
  `lifecycleChangedAt`, `lifecycleChangedByUserId`, `lifecycleReason`, `retiredAt`, `notes`; index
  `(lifecycleStatus, assetClass)`. New table `unitComponents` (parent, child, relationship,
  removable, installed/removed with actors and work orders). No existing value changes meaning:
  `vehicleType` stays, and every existing unit reads `lifecycleStatus = active`, unclassified.
- **`0243`** — triggers: a component installation is never edited and never deleted, and a detached
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
(`.nvmrc`), on the tree merged with `main` `2864723`; the result is recorded in the commit that
carries this document. The two suites that were red on `main` `240b2dd` itself
(`server/documentValidityCanonical.test.ts` and `server/calendarFixtures.test.ts`) are fixed on
`main` and pass here.
