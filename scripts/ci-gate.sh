#!/usr/bin/env bash
# The full LeaseOS gate, from an empty database. Every checkpoint since v20.2
# has passed this sequence; until now it was a habit rather than a script.
#
# Usage: DATABASE_URL=mysql://user:pass@host:port/db bash scripts/ci-gate.sh
#
# The database named in DATABASE_URL is DROPPED and recreated. Point this at a
# disposable database. It fails at the first gate that fails, and prints which.
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"
proto="${DATABASE_URL#mysql://}"
creds="${proto%%@*}"; hostpart="${proto#*@}"
user="${creds%%:*}"; pass="${creds#*:}"; [ "$pass" = "$creds" ] && pass=""
hostport="${hostpart%%/*}"; db="${hostpart#*/}"
host="${hostport%%:*}"; port="${hostport#*:}"; [ "$port" = "$host" ] && port=3306

gate() { printf '\n== %s ==\n' "$1"; }
mysqlc() { mysql -h "$host" -P "$port" -u "$user" ${pass:+-p"$pass"} "$@"; }

gate "0. Reserved migration slots untouched"
if ls drizzle/0016_*.sql drizzle/0017_*.sql >/dev/null 2>&1; then
  echo "FAIL: migration slot 0016 or 0017 is occupied. These are reserved for the Spatial and LoadSense branches."
  exit 1
fi
echo "0016/0017 reserved"

gate "1. Clean database"
mysqlc -e "DROP DATABASE IF EXISTS \`$db\`; CREATE DATABASE \`$db\`;"
echo "dropped and recreated $db"

# A second, separate database for the two widget suites.
#
# They are not fussy for the sake of it: widgetPersistence.db.test.ts DROPs and
# recreates widgetLayouts and widgetLayoutItems from migrations 0089/0090 in its
# beforeAll, and vitest runs files concurrently. Pointed at $db that would pull
# two tables out from under whatever else is mid-query, and gate 3 would have
# passed before it happened. Its own database costs one CREATE and removes the
# whole question.
widget_db="${db}_widgets"
mysqlc -e "DROP DATABASE IF EXISTS \`$widget_db\`; CREATE DATABASE \`$widget_db\`;"
export WIDGET_DB_URL="mysql://${user}${pass:+:$pass}@${host}:${port}/${widget_db}"
echo "dropped and recreated $widget_db (WIDGET_DB_URL set)"

gate "2. Migrations"
bash scripts/apply-migrations.sh

gate "3. Table parity"
bash scripts/verify-parity.sh

gate "4. Typecheck"
pnpm exec tsc --noEmit

# --- test-file typecheck ratchet -------------------------------------------
# tsconfig.json excludes **/*.test.ts, so no test file has ever been type-checked.
# That is how a test came to call dispatchContractFor with three parameter names that
# do not exist and still pass: vitest does not typecheck, and tsc never saw the file.
#
# Turning it on outright means triaging the pre-existing errors in one sitting. So the
# count is pinned instead: new test code is type-checked in effect, because anything
# that adds an error fails here. The pin is a debt to pay down, not a setting to keep:
# 85 at v23.00, 37 now. It only ever goes down.
TEST_TS_PIN=0
TEST_TS_NOW=$(pnpm exec tsc --noEmit -p tsconfig.tests.json 2>&1 | grep -cE "\.test\.tsx?\(" || true)
echo "test-file type errors: $TEST_TS_NOW (pinned ceiling $TEST_TS_PIN)"
if [ "$TEST_TS_NOW" -gt "$TEST_TS_PIN" ]; then
  echo "test-file type errors rose from $TEST_TS_PIN to $TEST_TS_NOW:"
  pnpm exec tsc --noEmit -p tsconfig.tests.json 2>&1 | grep -E "\.test\.tsx?\(" | head -20
  exit 1
fi
echo "clean"

gate "5. Bare protectedProcedure"
ROUTERS=$(ls server/*Router*.ts server/routers.ts server/recordsRouter.ts 2>/dev/null | sort -u)
count=$(cat $ROUTERS | grep -cE '\w+:\s*protectedProcedure\b' || true)
if [ "$count" != "0" ]; then echo "FAIL: $count bare protectedProcedure"; exit 1; fi
echo "0"

gate "6. Test suite (includes column-level parity and reserved-word audit)"
LEASEOS_PORTAL_MFA_KEY="${LEASEOS_PORTAL_MFA_KEY:-}" pnpm exec vitest run --reporter=basic 2>&1 | tee /tmp/vitest-gate.out
# pipefail is on, so a failing vitest still fails the gate through the pipe.

# A suite that needs a database and skips anyway reports as "↓", which is
# indistinguishable from one correctly standing down because no database is
# configured. Here one is, so a skipped .db.test.ts is a suite that is not
# running and looks like it chose not to.
#
# This is why the check exists: widgetPersistence.db.test.ts (24 cases) and
# widgetConflict.db.test.ts (10 cases) gate on WIDGET_DB_URL, nothing set it,
# and they had never run — in CI or anywhere. The first of them exists to guard
# a cross-tenant board overwrite, and it reported "skipped" the whole time.
skipped_db=$(grep -E '^ *↓ .*\.db\.test\.ts' /tmp/vitest-gate.out || true)
if [ -n "$skipped_db" ]; then
  echo "FAIL: a .db.test.ts suite skipped while a database is configured:"
  echo "$skipped_db"
  echo "Either its guard reads an environment variable this gate does not set, or the gate stopped setting one."
  exit 1
fi
echo "no database-backed suite skipped"

gate "7. Production build"
pnpm build

gate "Summary"
echo "tables: $(mysqlc -N -B -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='$db';")"
echo "migrations: $(ls drizzle/*.sql | wc -l)"
echo "role-authorized procedures: $(cat $ROUTERS | grep -c 'roleProcedure(' || true)"

echo "== 7b. External gate: portal mounts only externalProcedure, and the count is pinned =="
EXT=$(grep -c 'externalProcedure(' server/portalRouter.ts || true); ROLE_IN_PORTAL=$(grep -c 'roleProcedure(' server/portalRouter.ts || true)
echo "externally-gated procedures: $EXT"; [ "$ROLE_IN_PORTAL" = "0" ] || { echo "portalRouter mounts a role procedure"; exit 1; }

echo "== 7d. Tracking gate: trackingRouter mounts only trackingProcedure, and nothing else mounts one =="
TRK=$(grep -c 'trackingProcedure(' server/trackingRouter.ts || true); ROLE_IN_TRK=$(grep -c 'roleProcedure(' server/trackingRouter.ts || true); EXT_IN_TRK=$(grep -c 'externalProcedure(' server/trackingRouter.ts || true)
TRK_ELSEWHERE=$(grep -l 'trackingProcedure(' $ROUTERS 2>/dev/null | grep -v 'server/trackingRouter.ts' || true)
echo "tracking-gated procedures: $TRK"
if [ "$ROLE_IN_TRK" != "0" ] || [ "$EXT_IN_TRK" != "0" ]; then echo "FAIL: trackingRouter mounts a role or external procedure"; exit 1; fi
if [ "$TRK" = "0" ]; then echo "FAIL: no trackingProcedure in trackingRouter"; exit 1; fi
if [ -n "$TRK_ELSEWHERE" ]; then echo "FAIL: trackingProcedure mounted outside trackingRouter: $TRK_ELSEWHERE"; exit 1; fi

echo "== 7c. Machine gate: inbound mounts only integrationProcedure, and the count is pinned =="
INB=$(grep -c 'integrationProcedure(' server/integrationRouter.ts || true); ROLE_IN_INBOUND=$(sed -n '/export const inboundRouter/,$p' server/integrationRouter.ts | grep -c 'roleProcedure(' || true); EXT_IN_INBOUND=$(sed -n '/export const inboundRouter/,$p' server/integrationRouter.ts | grep -c 'externalProcedure(' || true)
echo "integration-gated procedures: $INB"
if [ "$ROLE_IN_INBOUND" != "0" ] || [ "$EXT_IN_INBOUND" != "0" ]; then echo "FAIL: inboundRouter mounts a role or external procedure"; exit 1; fi
if [ "$INB" = "0" ]; then echo "FAIL: no integrationProcedure in integrationRouter"; exit 1; fi
echo "== 8. Current-state document is generated, not claimed =="
cp LEASEOS_CURRENT_STATE.md /tmp/current-state.before
# No argument, so the release comes from LEASEOS_RELEASE — the file the document
# names as where its Release row is read from. This used to scrape the release
# out of the document and hand it straight back to the generator, which meant
# the one row the document sources from a file was compared only against itself.
# It went unnoticed for exactly that reason: the document said v22.21 while
# LEASEOS_RELEASE still said v22.20, and every gate run passed.
bash scripts/current-state.sh >/dev/null
if ! diff -q /tmp/current-state.before LEASEOS_CURRENT_STATE.md >/dev/null; then echo "LEASEOS_CURRENT_STATE.md is stale — regenerate with scripts/current-state.sh"; diff /tmp/current-state.before LEASEOS_CURRENT_STATE.md | head -20; exit 1; fi
echo "current"
echo "== PASS =="
