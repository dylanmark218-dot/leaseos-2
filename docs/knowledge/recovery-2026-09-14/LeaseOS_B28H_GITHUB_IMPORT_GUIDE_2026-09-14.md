# LeaseOS B28h unified GitHub import guide

Use the GitHub-ready repository ZIP or the all-branches Git bundle. The ZIP already contains `.git`; do not use GitHub's browser file uploader if you want to preserve branch history.

## From the GitHub-ready ZIP

```bash
unzip LeaseOS_B28H_Unified_GitHub_Ready_2026-09-14.zip
cd LeaseOS-Unified-B28h-Repository
git status
git remote add origin git@github.com:<OWNER>/<REPOSITORY>.git
git push -u origin main
git push origin --all
git push origin --tags
```

## From the bundle

```bash
git clone LeaseOS_B28H_Unified_All_Branches_2026-09-14.bundle LeaseOS
cd LeaseOS
git switch main
git remote add origin git@github.com:<OWNER>/<REPOSITORY>.git
git push -u origin main
git push origin --all
git push origin --tags
```

Protect `main`, require pull requests and CI, disallow force-pushes to source/archive anchors, and keep `candidate/b28h-widget-engine` out of production until migration and source-contract blockers are resolved.
