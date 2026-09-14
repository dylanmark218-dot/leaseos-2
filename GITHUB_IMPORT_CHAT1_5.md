# GitHub import — LeaseOS Chat1–Chat5 reconciled repository

This repository already contains Git branches and tags. **Do not use GitHub’s web “Upload files” flow** if branch history matters.

## Recommended: private repository

Chat5 contains an assessor answer key explicitly marked not for distribution. The cleaned repository isolates it on `restricted/chat5-assessor-key`, but branches in one GitHub repository share the repository’s visibility. Use a **private** GitHub repository if you push every branch.

```bash
git remote add origin https://github.com/<YOUR_ACCOUNT>/<YOUR_REPO>.git
git push -u origin main
git push origin --all
git push origin --tags
```

## If the GitHub repository will be public

Do **not** push the restricted branch:

```bash
git push -u origin main
for b in $(git for-each-ref --format='%(refname:short)' refs/heads | grep -v '^restricted/'); do
  git push origin "$b:$b"
done
git push origin --tags
```

Before making a repository public, also review `archive/*` for commercial/confidential project material.

## Merge order for the new Chat5 work

1. Keep canonical `main` unchanged at the application layer.
2. Review `upgrade/0087-driver-academy`.
3. Review `upgrade/0088-academy-hardening`.
4. Review `upgrade/0089-academy-readiness`.
5. Review `fix/chat5-module-paths-and-vitest`.
6. Follow `integration/chat5-academy-port-plan`; allocate migrations from the actual next free target slots and add the missing Academy SQL/database wiring before merging implementation into root application paths.

B28H remains a separate staged candidate; its migration slots must also be allocated against the same target before either candidate is integrated.
