# GitHub Import

This package includes a complete `.git` repository and a separate Git bundle.

## Existing local repository package

If you unzip `LeaseOS-Reconciled-Git-Repo-2026-09-14.zip`, the `.git` directory is already present with `main`, milestone branches, upgrade branch refs, candidate branches, and tags.

Add your GitHub remote and push everything:

```bash
git remote add origin git@github.com:<OWNER>/<REPOSITORY>.git
git push -u origin main
git push origin --all
git push origin --tags
```

## Git bundle import

```bash
git clone LeaseOS-Reconciled-2026-09-14.bundle LeaseOS
cd LeaseOS
git switch main
git remote add origin git@github.com:<OWNER>/<REPOSITORY>.git
git push -u origin main
git push origin --all
git push origin --tags
```

Recommended GitHub settings after push: make the repository private until licensing/secret scanning is reviewed; protect `main`; require pull requests; require CI/checks before merge; disallow force-push to `main`; enable secret scanning and Dependabot if available.
