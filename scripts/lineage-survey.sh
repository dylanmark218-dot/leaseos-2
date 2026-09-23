#!/usr/bin/env bash
# Reads every ref's TREE (never its name) and prints the lineage survey table used by
# docs/route-intelligence/LINEAGE_RECONCILIATION.md. Read-only.
#
# Usage: bash scripts/lineage-survey.sh [base-ref]   (base defaults to origin/main)
# Add other repositories as remotes first if you want them in the table, e.g.
#   git remote add sibling /path/to/leaseos && git fetch sibling 'refs/remotes/origin/*:refs/remotes/sibling/*'
set -euo pipefail
cd "$(dirname "$0")/.."
BASE="${1:-origin/main}"
printf '| Ref | HEAD | Release | Merge base w/ %s | Ahead/Behind | Tables | Migs | Highest migration | Test files/it() | Root |\n|---|---|---|---|---|---|---|---|---|---|\n' "$BASE"
refs=$(git for-each-ref --format='%(refname:short)' refs/heads refs/remotes | grep -vE '/HEAD$')
for r in $refs; do
  sha=$(git rev-parse --short=9 "$r")
  rel=$(git show "$r:LEASEOS_RELEASE" 2>/dev/null | tr -d '\r\n'); [ -z "$rel" ] && rel="(none)"
  mb=$(git merge-base "$BASE" "$r" 2>/dev/null | cut -c1-9 || true); [ -z "$mb" ] && mb="NONE"
  if [ "$mb" != "NONE" ]; then ab="$(git rev-list --count "$BASE..$r")/$(git rev-list --count "$r..$BASE")"; else ab="n/a"; fi
  tables=$(git show "$r:drizzle/schema.ts" 2>/dev/null | grep -c 'mysqlTable(' || true)
  migs=$(git ls-tree --name-only "$r" drizzle/ 2>/dev/null | grep -c '\.sql$' || true)
  hi=$(git ls-tree --name-only "$r" drizzle/ 2>/dev/null | grep '\.sql$' | sed 's#drizzle/##' | sort | tail -1)
  tf=$(git ls-tree -r --name-only "$r" 2>/dev/null | grep -cE '^server/.*\.test\.ts$' || true)
  its=$(for f in $(git ls-tree -r --name-only "$r" 2>/dev/null | grep -E '^server/.*\.test\.ts$'); do git show "$r:$f"; done | grep -cE '^\s*it\(' || true)
  root=$(git rev-list --max-parents=0 "$r" | tail -1 | cut -c1-9)
  printf '| %s | %s | %s | %s | %s | %s | %s | %s | %s/%s | %s |\n' "$r" "$sha" "$rel" "$mb" "$ab" "$tables" "$migs" "${hi:-}" "$tf" "$its" "$root"
done
