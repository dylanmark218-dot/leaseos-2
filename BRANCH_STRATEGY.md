# LeaseOS Branch Strategy

## Exact source milestones

- `milestone/v20` → `015bfb49aa6a`
- `milestone/v22.16` → `f1b9e283c04f`
- `milestone/cal05a` → `bcfe993d54c0`
- `main` → latest CAL05a source plus reconciliation/audit material

Tags `source-v20`, `source-v22.16`, and `source-cal05a` preserve the exact imported trees.

## Upgrade branches

Every `LEASEOS_B*.md` upgrade in the latest source has a corresponding `upgrade/...` branch. Because the supplied archives do not contain a separate exact source snapshot for every individual B-step, each upgrade branch points to the **earliest exact milestone snapshot that contains it**. These branches are for historical review and merge planning; they must not be mistaken for isolated one-feature patches.

Use `audit/branch_manifest.csv` to see the exact mapping.

## Merge candidates

- `candidate/v20-to-v22.16` → complete v22.16 cumulative state.
- `candidate/v22.16-to-cal05a` → complete CAL05a cumulative state.

The original supplied cumulative `.diff` files are retained under `archive/patches/` for forensic comparison, while Git's real snapshot history is authoritative for this reconstructed repository.

## Going forward

For every new upgrade, branch from current `main` as `upgrade/<version>-<feature>`, keep that branch isolated to the feature, run the project gate/tests, open a pull request into `main`, and tag accepted milestone builds. That will make future upgrades truly mergeable one-by-one instead of requiring reconstruction from cumulative ZIPs.
