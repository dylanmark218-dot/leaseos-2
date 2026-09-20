# LeaseOS Project Recovery — GitHub import guide

## Recommended repository visibility

Use a **private GitHub repository** for the full GitHub-ready ZIP or all-branches bundle. The repository history contains the intentionally restricted `restricted/chat5-assessor-key` ref. Do not publish the full-history artifact to a public repository unless that ref and its objects are deliberately purged first.

The clean RC source ZIP contains only the candidate worktree and no Git history.

## Recovery release candidate

- RC branch: `candidate/project-recovery-rc`
- RC commit: `5d3e42bc1b06eb32ab65698eeb5ca6beb5406983`
- Implementation commit: `18444d4c9622e61e75ae595380161990ff885142`
- Recovery tag: `project-recovery-2026-09-14`
- Existing canonical `main` remains: `74d99de54387894f42daa54c802e4a536eab9313`
- Branch heads: **346**
- Tags: **33**

`main` was intentionally not advanced because the recovery environment could not rerun the complete dependency-backed pnpm/Vitest/MySQL/browser/native-device release gate.

## Option A — use the GitHub-ready repository ZIP

Extract the ZIP, enter the repository, and verify:

```bash
git status
git switch candidate/project-recovery-rc
git rev-parse HEAD
git fsck --full --no-dangling
```

Create an empty **private** GitHub repository, then add its remote and push all refs:

```bash
git remote add origin <YOUR_PRIVATE_GITHUB_REPO_URL>
git push -u origin candidate/project-recovery-rc
git push origin --all
git push origin --tags
```

Do not make `candidate/project-recovery-rc` the production/default branch until the full release gate passes. It is suitable as the review/merge candidate.

## Option B — use the all-branches Git bundle

```bash
git clone LeaseOS_Project_Recovery_All_Branches_2026-09-14.bundle LeaseOS
cd LeaseOS
git switch candidate/project-recovery-rc
git fsck --full --no-dangling
```

A bundle clone may choose another local branch when several refs point to related commits. Explicitly switch to the RC branch before review.

## Promotion gate

Before advancing `main`, run at minimum:

1. clean dependency install with pnpm 10.4.1;
2. complete unit/integration suite;
3. clean and upgrade-path MySQL migrations through 0109;
4. full TypeScript/build/CI gate;
5. browser/mobile smoke and E2E;
6. native-device field-runtime tests;
7. tenant-isolation and cross-organization authorization tests;
8. authenticated LoadSense gateway/device-ingestion tests;
9. Academy production DB/readiness tests;
10. confidential-ref review before any repository visibility change.
