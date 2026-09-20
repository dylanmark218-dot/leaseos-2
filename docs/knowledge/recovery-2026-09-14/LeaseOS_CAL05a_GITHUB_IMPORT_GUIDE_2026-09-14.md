# LeaseOS CAL05a unified GitHub import

The GitHub-ready ZIP contains a complete `.git` repository. The bundle is the safest single-file history backup. The default checkout is `main`, which is the merged CAL05a/reconciled source line; audit and fix work are preserved on separate branches.

## Important refs

- `main` — merged latest source/reconciliation tree, with both earlier unified history and incoming reconciled history as parents.
- `source/cal05a-original` — exact incoming CAL05a source snapshot.
- `archive/unified-v22.16-main` — previous canonical unified main before CAL05a.
- `reconciled/*` — all incoming reconciled repository branches preserved without overwriting earlier refs.
- `upgrade/b22-17-communications`, `upgrade/b22-18-comms-dispatch`, `upgrade/b22-19-offline-package` — canonical aliases for the new supplied upgrade anchors.
- `integration/unified-cal05a-audit` — refreshed audit, branch map and gap matrix.
- `integration/cal05a-recommended-fixes` — three prepared repository fixes for CI/auth/release-source review.

## Push an extracted GitHub-ready ZIP

```bash
git switch main
git remote add origin https://github.com/<OWNER>/<REPOSITORY>.git
git push -u origin main
git push origin --all
git push origin --tags
```

## Clone the bundle

```bash
git clone LeaseOS_CAL05a_Unified_All_Branches_2026-09-14.bundle LeaseOS
cd LeaseOS
git switch main
git remote add origin https://github.com/<OWNER>/<REPOSITORY>.git
git push -u origin main
git push origin --all
git push origin --tags
```

Keep the GitHub repository private until licensing and secret-scanning policy are deliberately resolved. Protect `main`, require pull requests and CI, disallow force-pushes, and treat `reconciled/*`, `source/*`, `baseline/*` and `archive/*` as record/history refs rather than feature-development branches.
