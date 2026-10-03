#!/usr/bin/env bash
# Clock sweep (CI-0.2): run test files under several system clocks and require them to pass under
# every one. This is the evidence behind a `clock_independent` verdict in
# server/calendarFixtures.test.ts — not a reading of the file, a run of it with the calendar moved.
#
# BOTH clocks move. The JavaScript clock is faked in-process (scripts/clock-sweep/fakeclock.setup.ts).
# The JavaScript clock starts at each sweep date and runs forward in real time. The database clock
# is pinned for every connection through MariaDB's `init_connect`, which runs
# only for non-SUPER accounts, so the sweep connects as a dedicated account it creates with rights
# on the test database alone. A fixture that writes NOW() and a router that compares it with a fixed
# date would pass a JavaScript-only sweep and still break in November; this one sees it.
#
#   DATABASE_URL=mysql://root@127.0.0.1:3306/leaseos bash scripts/clock-sweep.sh server/a.test.ts ...
#   CLOCKS="2026-11-11T12:00:00Z 2030-01-01T00:00:00Z" bash scripts/clock-sweep.sh ...
#
#   FRESH=1 bash scripts/clock-sweep.sh ...   # drop, recreate and migrate the database before each clock
#
# FRESH=1 is for suites that are not idempotent against a database they have already run in
# (compliancePassport is one): without it, a failure at the second clock may be the reuse, not the
# date. It DROPS the database named in DATABASE_URL, exactly as scripts/ci-gate.sh does.
#
# Needs: a migrated database, and a DATABASE_URL whose account may CREATE USER and SET GLOBAL.
# Leaves init_connect empty on exit, however it exits.
set -euo pipefail
cd "$(dirname "$0")/.."

[ $# -gt 0 ] || { echo "usage: scripts/clock-sweep.sh <test file>..." >&2; exit 2; }
: "${DATABASE_URL:?DATABASE_URL must point at a migrated database}"
CLOCKS="${CLOCKS:-2026-09-24T12:00:00Z 2026-10-31T12:00:00Z 2026-11-03T12:00:00Z 2026-11-11T12:00:00Z 2027-06-01T12:00:00Z 2030-09-24T12:00:00Z}"

re='^mysql://([^:@/]+)(:([^@]*))?@([^:/]+)(:([0-9]+))?/([^?]+)'
[[ "$DATABASE_URL" =~ $re ]] || { echo "cannot parse DATABASE_URL" >&2; exit 2; }
user="${BASH_REMATCH[1]}"; pass="${BASH_REMATCH[3]}"; host="${BASH_REMATCH[4]}"; port="${BASH_REMATCH[6]:-3306}"; db="${BASH_REMATCH[7]}"
mysqlc() { mysql -u"$user" ${pass:+-p"$pass"} -h"$host" -P"$port" "$@"; }

sweeper=clock_sweep
mysqlc -e "DROP USER IF EXISTS '$sweeper'@'%'; CREATE USER '$sweeper'@'%'; GRANT ALL PRIVILEGES ON \`$db\`.* TO '$sweeper'@'%';"
trap 'mysqlc -e "SET GLOBAL init_connect=\"\"" || true' EXIT
SWEEP_URL="mysql://$sweeper@$host:$port/$db"

failed=0
for clock in $CLOCKS; do
  if [ "${FRESH:-0}" = 1 ]; then
    mysqlc -e "SET GLOBAL init_connect=''; DROP DATABASE IF EXISTS \`$db\`; CREATE DATABASE \`$db\`;"
    bash scripts/apply-migrations.sh >/dev/null
  fi
  epoch=$(date -u -d "$clock" +%s)
  # An offset from the real clock, fixed when the run starts, so each new connection opens at
  # "$clock plus however long the run has taken" rather than every connection sharing one instant.
  offset=$(( epoch - $(date -u +%s) ))
  mysqlc -e "SET GLOBAL init_connect='SET timestamp=UNIX_TIMESTAMP()+($offset)'"
  got=$(mysql -u"$sweeper" -h"$host" -P"$port" "$db" -N -e "SELECT UNIX_TIMESTAMP(NOW())")
  (( got >= epoch && got - epoch < 60 )) || { echo "database clock not pinned at $clock (read $got, wanted $epoch)" >&2; exit 1; }
  echo "== clock $clock (JavaScript and database)"
  if CLOCK_SWEEP_AT="$clock" DATABASE_URL="$SWEEP_URL" npx vitest run -c scripts/clock-sweep/vitest.config.ts "$@"; then
    echo "   pass at $clock"
  else
    echo "   FAIL at $clock"; failed=1
  fi
done
[ $failed -eq 0 ] && echo "== CLOCK-INDEPENDENT under every clock" || { echo "== CLOCK-DEPENDENT: see the failing clock above"; exit 1; }
