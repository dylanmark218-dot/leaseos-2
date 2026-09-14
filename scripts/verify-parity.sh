#!/usr/bin/env bash
# Schema and migrations must declare the same number of tables. Verified,
# never assumed — a table added to schema.ts without a migration is a runtime
# failure that typecheck cannot catch.
set -euo pipefail

schema=$(grep -c 'mysqlTable(' drizzle/schema.ts)
migrations=$(cat drizzle/*.sql | grep -cE '^CREATE TABLE')

echo "schema.ts declares : $schema"
echo "migrations create  : $migrations"

if [ "$schema" -ne "$migrations" ]; then
  echo "PARITY FAILURE — schema and migrations disagree"
  exit 1
fi
echo "parity OK"
