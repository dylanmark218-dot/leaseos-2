# LeaseOS — Branch Reconciliation Status

**Written after receiving `LEASEOS_B18_FREE_SPATIAL_NAVIGATION.md` and
`LEASEOS_B19_LOADSENSE_MATERIAL_MOVEMENT.md`.**

---

## 1. A migration collision existed, and it is now resolved

Both branches descend from **v16 / B17 (80 tables, 15 migrations)** and both claimed slot `0016`:

| | Branch A (this trunk) | Branch B (spatial + LoadSense) |
|---|---|---|
| 0016 | `0016_billing_adjustments.sql` | `0016_fieldroute_spatial_navigation.sql` |
| 0017 | — | `0017_loadsense_material_movement.sql` |
| Tables | 87 | 96 |
| Migrations | 17 | 18 |

Applying both branches in either order would have produced a duplicate-index or
duplicate-table failure, or silently skipped one migration depending on the runner.

**Resolved on this trunk:** billing adjustments moved `0016 → 0018`, journal `idx` and `tag`
updated to match. Slots **0016 and 0017 are now reserved** for the spatial and LoadSense
migrations, so Branch B applies unchanged.

Re-verified after the renumber: **87 tables applied clean, 472 tests passing, parity 87/87.**

---

## 2. What each branch actually contains

**Branch A — this trunk (v19):**
B18 billing adjustments, disputes, third-party contractors and callout authority (7 tables) ·
B19 end-to-end workflow wiring — domain emitters, seed bootstrap, database-backed worker ports,
12 integration tests proving mutation → outbox → worker → task → notification.

**Branch B — spatial + LoadSense:**
B18 self-hosted spatial navigation — DLS resolver, land-grid import, owned road graph, commercial
pathfinder, offline route package (6 tables) · B19 LoadSense — axle-weight sensing, calibration,
material movement chain (10 tables).

**They do not overlap.** Different tables, different engines, different problems. This is a clean
merge once both are in one place — unlike the still-outstanding Integrated Operations branch, which
has never been supplied at all.

---

## 3. I can now run the validation Branch B could not

Branch B's own checkpoint says:

> "The complete project test/build cannot be truthfully claimed here because this unpacked artifact
> has no `node_modules`, package download is unavailable, and no MySQL/MariaDB binary is installed
> in this runtime. Run migration 0017 plus the full suite/build in the established B16 CI database
> job before release."

**This container now has that.** MariaDB 10.11 is installed and running, dependencies install, and
the full suite executes against a real database — that is how B16 through B19 were verified here.

So the gate Branch B correctly refused to claim can actually be run. **It needs the code, not the
checkpoint document.** Send the branch as a `.zip` and I can, in one pass:

1. Apply all 18 migrations in order against a real database
2. Verify schema/migration parity independently
3. Run the complete suite including both branches' tests
4. Typecheck and build
5. Report exactly what passes and what does not

---

## 4. Two things worth flagging in Branch B's design

Both specs are careful work. Two points I would raise:

**The safety boundary is right and worth keeping explicit.** "No weigh-station or
enforcement-evasion preference — mandatory checkpoints are not an avoidance optimization target"
is a boundary that should be asserted by a *test*, not only by documentation, in the same way the
workflow engine's coordination boundary is now test-pinned. A future contributor adding an
"avoid delays" heuristic could otherwise reintroduce it without noticing.

**Source precedence is exactly right:** `certified_scale > calibrated LoadSense > driver-entered >
uncalibrated > estimate`. That maps directly onto this trunk's `measurementMethod` enum
(`meter | scale | gauge | estimate | customer_stated | unknown`) and the B18 billing rule that an
estimate cannot auto-generate a charge. **On merge these two should be unified into one precedence
ladder rather than left as parallel vocabularies** — two ways of saying "how good is this number"
will drift.

---

## 5. Outstanding branches

| Branch | Status |
|---|---|
| Integrated Operations (`operationsEngine.ts`, `aiSecretary.ts`, `OperationsControlCenter.tsx`) | **Never supplied.** Flagged since the V7 manifest. Cannot be merged from a description. |
| Spatial + LoadSense | Specs received, **code not supplied.** Migration slots now reserved. |
| This trunk (v19) | 87 tables · 17 migrations · 472 tests · typecheck clean |

Three branches, one of them a year of assumed work, and none reconciled. That is now the largest
risk to the project — larger than any individual missing feature.

---

## 6. Recommended next step

Upload the spatial + LoadSense branch as a `.zip`. I will merge it onto this trunk, run every
migration and the full suite against the real database, and report the result honestly — including
anything that fails.

If the Integrated Operations branch can also be recovered, send both and they can be reconciled in
one pass rather than three.
