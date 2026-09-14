# GitHub import guide

This repository is already a Git repository with branches and tags. Do **not** use GitHub's web “upload files” flow if you want to preserve the branch structure; use Git from a terminal.

## Push to a new empty GitHub repository

```bash
git remote add origin https://github.com/<YOUR_ACCOUNT>/<YOUR_REPO>.git
git push -u origin main
git push origin --all
git push origin --tags
```

Recommended protection after push:

- Protect `main`; require pull requests.
- Require the existing CI gate plus a secret scan before merge.
- Disallow force-pushes to `main`, `baseline/v20.2`, and `source/v22.16-original`.
- Treat `upgrade/*` as traceability/PR branches, not exact historical code snapshots.
- Review the two `fix/*` branches as normal pull requests before merging.

## Important branches

- `main` — cleaned v22.16 source plus repository audit/history material.
- `source/v22.16-original` — exact supplied v22.16 source snapshot.
- `baseline/v20.2` — exact v20.2 state reconstructed by reverse-applying the supplied cumulative patch.
- `fix/fail-closed-permission-drift` — proposed authorization correction matching the checkpoint counts.
- `fix/current-state-release-autodetect` — standalone release-generator correction.
- `upgrade/*` — one traceability branch per supplied checkpoint.

A `.bundle` is also supplied outside the repository ZIP. It preserves all refs and can be cloned with `git clone <bundle-file> leaseos`.
