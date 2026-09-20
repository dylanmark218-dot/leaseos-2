# LeaseOS Chat1–Chat5 unified GitHub import guide

Use the GitHub-ready ZIP or the all-branches bundle. The full package contains a restricted assessor-answer-key branch, so **keep the GitHub repository private** unless that ref is deliberately excluded.

## From the GitHub-ready ZIP

```bash
unzip LeaseOS_Chat1-5_Unified_GitHub_Ready_2026-09-14.zip
cd LeaseOS-Unified-Chat1-5-Repository
git remote add origin git@github.com:<OWNER>/<REPOSITORY>.git
git push -u origin main
git push origin --all
git push origin --tags
```

## From the bundle

```bash
git clone LeaseOS_Chat1-5_Unified_All_Branches_2026-09-14.bundle LeaseOS
cd LeaseOS
git switch main
git remote add origin git@github.com:<OWNER>/<REPOSITORY>.git
git push -u origin main
git push origin --all
git push origin --tags
```

## Recommended protections

Protect `main`; require pull requests and CI; disallow force-push; enable secret/dependency scanning. Treat `candidate/*`, `integration/*` and `upgrade/*` as review lanes. Do not merge `restricted/chat5-assessor-key` to main and do not push that ref to a public repository.
