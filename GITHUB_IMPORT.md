# GitHub Import / Push Guide

This repository already contains the reconstructed history and branches. After creating an empty GitHub repository, add it as `origin` and push.

```bash
git remote add origin git@github.com:YOUR-ORG-OR-USER/leaseos.git
git push -u origin main
git push origin snapshot/v20 snapshot/v22.16 snapshot/cal05a-v22.20
git push origin candidate/b28h-widget-engine archive/raw-inputs archive/deduped-artifacts
git push origin 'refs/heads/upgrade/*:refs/heads/upgrade/*'
git push origin 'refs/heads/candidate/*:refs/heads/candidate/*'
git push origin --tags
```

Recommended GitHub settings: protect `main`, require pull requests and the existing CI workflow, block force-pushes to `main`, and keep the `snapshot/*` and `archive/*` branches read-only.

For B28H, open a pull request only after migration renumbering and procedure reconciliation are completed. The current candidate is intentionally staged, not production-integrated.
