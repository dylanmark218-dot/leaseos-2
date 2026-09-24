#!/usr/bin/env bash
# B23.1B — a test may not depend on a record id it did not create.
#
# The failure this reproduces, deliberately and in one minute:
#
#   `enforcementApi.test.ts` wrote its enforcement events against `unitId: 127`,
#   a unit it never created. Every such event opens a work order, and
#   `shopRouter` resolves that work order through `workOrderInScope`, which asks
#   `coreRecordOwnership` who owns the unit. The tenant-scope suites create
#   units from the auto-increment and claim them for an organization. On a
#   database used once the ids never meet; on one reused across runs they do,
#   and five releases fail with "Work order N not found" — a tenant refusal that
#   is completely correct about somebody else's unit and reads exactly like an
#   authorization bug. Three more suites carried the same defect.
#
# Rather than wait for that collision to happen by accident, this causes it:
# a squatter organization claims every low record id the suites are known to
# have hardcoded, and then the affected suites run. A suite that owns its
# fixtures does not notice. A suite that named an id passes it to a scope check
# that now, correctly, says not found.
#
# It runs the four suites that carried the defect, not the whole tree, so it
# costs about a minute rather than doubling the gate.
#
# Usage: DATABASE_URL=mysql://user:pass@host:port/db bash scripts/verify-fixture-isolation.sh
# The database named is NOT touched; a scratch database beside it is used.
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"
proto="${DATABASE_URL#mysql://}"
creds="${proto%%@*}"; hostpart="${proto#*@}"
user="${creds%%:*}"; pass="${creds#*:}"; [ "$pass" = "$creds" ] && pass=""
hostport="${hostpart%%/*}"; db="${hostpart#*/}"
host="${hostport%%:*}"; port="${hostport#*:}"; [ "$port" = "$host" ] && port=3306

scratch="${db}_isolation"
mysqlc() { mysql --default-character-set=utf8mb4 -h "$host" -P "$port" -u "$user" ${pass:+-p"$pass"} "$@"; }

# The suites that carried the defect. Each one now creates the unit or operator
# it writes against; this is what proves that stayed true.
SUITES="server/enforcementApi.test.ts server/productionPath.test.ts server/fieldroute.test.ts server/operationalTruth.test.ts"

echo "== 0. scratch database =="
mysqlc -e "DROP DATABASE IF EXISTS \`$scratch\`; CREATE DATABASE \`$scratch\`;"
echo "  $scratch"

echo "== 1. the schema, from migrations =="
DATABASE_URL="mysql://${user}${pass:+:$pass}@${host}:${port}/${scratch}" \
  bash scripts/apply-migrations.sh >/dev/null
tables=$(mysqlc -N -B -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='$scratch';")
[ "$tables" -gt 400 ] || { echo "FAIL: only $tables tables after migrating — migrations did not apply." >&2; exit 1; }
echo "  $tables tables"

echo "== 2. a squatter claims every id the suites used to hardcode =="
# Low ids, because auto-increment starts at 1 and these are what a long-lived
# database hands out first. Units and operators, because those are the two
# record types `coreRecordOwnership` scopes.
mysqlc "$scratch" <<'SQL'
INSERT INTO organizations (orgRef, name, status) VALUES ('ORG-SQUATTER','Squatter Ltd','active');
INSERT IGNORE INTO units (id, unitNumber, vehicleType) VALUES
 (1,'SQ-1','hydrovac'),(2,'SQ-2','hydrovac'),(3,'SQ-3','hydrovac'),(27,'SQ-27','hydrovac'),
 (127,'SQ-127','hydrovac'),(142,'SQ-142','hydrovac'),(144,'SQ-144','hydrovac'),
 (218,'SQ-218','hydrovac'),(500,'SQ-500','hydrovac');
INSERT INTO coreRecordOwnership (orgRef, recordType, recordId, assignedByUserId)
 SELECT 'ORG-SQUATTER','unit',id,1 FROM units WHERE id IN (1,2,3,27,127,142,144,218,500);
-- The operator rows are CREATED, not merely claimed. Claiming ownership of an
-- id no row has would poison it for the next suite that legitimately creates an
-- operator and happens to land on it — which is not a thing any real suite
-- does, and would make this script fail well-written tests. Creating them also
-- pushes the auto-increment past the squatted range.
INSERT IGNORE INTO operators (id, name, licenseNumber) VALUES
 (1,'SQ Op 1','SQ-LIC-1'),(2,'SQ Op 2','SQ-LIC-2'),(3,'SQ Op 3','SQ-LIC-3'),
 (7,'SQ Op 7','SQ-LIC-7'),(9,'SQ Op 9','SQ-LIC-9'),(47,'SQ Op 47','SQ-LIC-47'),
 (99,'SQ Op 99','SQ-LIC-99'),(221,'SQ Op 221','SQ-LIC-221');
INSERT INTO coreRecordOwnership (orgRef, recordType, recordId, assignedByUserId)
 SELECT 'ORG-SQUATTER','operator',id,1 FROM operators WHERE id IN (1,2,3,7,9,47,99,221);

-- B23.2 — and the low USER ids, with memberships.
--
-- This is the same defect pointed at identity, and it bit immediately:
-- `fieldroute.test.ts` said `const TEST_USER_ID = 1`, which held only while
-- nothing gave user 1 an organization membership. B23.2 added the first code
-- that creates memberships and a suite that creates users; on an empty database
-- the first of those users is id 1. `resolveActingScope` then answered with that
-- organization instead of the historical single tenant, and every unowned
-- fixture row in fieldroute became invisible — seven failures that read exactly
-- like an authorization bug.
--
-- A member of the squatter is what a test hardcoding a low user id will collide
-- with, so that is what the squatter is.
INSERT IGNORE INTO users (id, openId, name, email, loginMethod) VALUES
 (1,'sq-openid-1','SQ User 1','sq1@example.test','test'),
 (2,'sq-openid-2','SQ User 2','sq2@example.test','test'),
 (3,'sq-openid-3','SQ User 3','sq3@example.test','test');
INSERT INTO organizationMemberships
 (membershipRef, orgRef, userId, membershipType, status, effectiveFrom, createdByUserId)
 SELECT CONCAT('MEM-SQ-', id), 'ORG-SQUATTER', id, 'employee', 'active', '2020-01-01', 1
 FROM users WHERE id IN (1,2,3);
SQL
claimed=$(mysqlc -N -B "$scratch" -e "SELECT COUNT(*) FROM coreRecordOwnership;")
echo "  $claimed records claimed by ORG-SQUATTER"

echo "== 3. the suites that used to name those ids =="
if DATABASE_URL="mysql://${user}${pass:+:$pass}@${host}:${port}/${scratch}" \
   pnpm exec vitest run $SUITES --reporter=basic; then
  echo ""
  echo "== FIXTURE ISOLATION VERIFIED =="
  echo "Every suite above owns the records it writes against."
  mysqlc -e "DROP DATABASE IF EXISTS \`$scratch\`;"
else
  echo "" >&2
  echo "FAIL: a suite above depends on a record id it did not create." >&2
  echo "" >&2
  echo "A squatter organization owns units 1,2,3,27,127,142,144,218,500 and" >&2
  echo "operators 1,2,3,7,9,47,99,221 in this database. A 'not found' above is" >&2
  echo "the tenant scope refusing a record that belongs to somebody else — the" >&2
  echo "refusal is correct, and the fixture is what is wrong." >&2
  echo "" >&2
  echo "Fix the test, not the scope: create the unit/operator/job/USER it needs and" >&2
  echo "use the returned id. See the note in server/enforcementApi.test.ts." >&2
  echo "" >&2
  echo "The scratch database $scratch is left in place for inspection." >&2
  exit 1
fi
