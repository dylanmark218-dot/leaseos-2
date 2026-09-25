#!/usr/bin/env bash
# B23.1A — migration 0207 (formerly 0170), verified against a real database rather than read.
#
# 0170 is an AUTHORIZATION migration: it decides, per existing grant, which
# company that grant will speak for from now on. Reading the SQL proves the
# syntax; it does not prove the classification. This builds the pre-0170 world,
# puts a row of every legacy shape into it, applies 0170 alone, and asserts what
# each row became.
#
#   pre-0170 schema  ->  legacy rows  ->  apply 0170  ->  assert classification
#
# The categories are the ones the migration's own header names:
#
#   A  exactly one live membership   -> attributed to it        (authority PRESERVED, now scoped)
#   B  more than one live membership -> unscoped_legacy         (authority QUARANTINED)
#   C  no membership at all          -> the historical tenant   (authority PRESERVED, now scoped)
#   F  malformed (branch, no branch) -> unscoped_legacy         (authority QUARANTINED)
#   R  revoked rows                  -> untouched               (no authority either way)
#
# No category gains authority. That is the property this script exists to prove.
#
# Usage: DATABASE_URL=mysql://user:pass@host:port/db bash scripts/verify-migration-0207.sh
# The database named is NOT touched; a scratch database beside it is used.
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"
proto="${DATABASE_URL#mysql://}"
creds="${proto%%@*}"; hostpart="${proto#*@}"
user="${creds%%:*}"; pass="${creds#*:}"; [ "$pass" = "$creds" ] && pass=""
hostport="${hostpart%%/*}"; db="${hostpart#*/}"
host="${hostport%%:*}"; port="${hostport#*:}"; [ "$port" = "$host" ] && port=3306

scratch="${db}_m0207"
mysqlc() { mysql --default-character-set=utf8mb4 -h "$host" -P "$port" -u "$user" ${pass:+-p"$pass"} "$@"; }
q() { mysqlc -N -B "$scratch" -e "$1"; }

fail() { echo "FAIL: $1" >&2; exit 1; }
expect() { # expect <label> <actual> <wanted>
  if [ "$2" != "$3" ]; then fail "$1 — expected '$3', got '$2'"; fi
  echo "  ok: $1 = $2"
}

echo "== 0. scratch database =="
mysqlc -e "DROP DATABASE IF EXISTS \`$scratch\`; CREATE DATABASE \`$scratch\`;"
echo "created $scratch"

echo "== 1. the world before 0170 =="
# Every migration except the one under test. Applied the way the runner applies
# them, so this is the real pre-0170 schema and not a hand-written guess.
for f in $(ls drizzle/*.sql | sort); do
  case "$(basename "$f")" in 0207_organization_scoped_role_grants.sql) continue ;; esac
  if grep -qE '^BEGIN$' "$f"; then
    { printf 'DELIMITER $$\n'
      sed -e 's/-->[[:space:]]*statement-breakpoint//' -e 's/^END;$/END$$/' "$f"
      printf '\nDELIMITER ;\n'
    } | mysqlc "$scratch"
  else
    sed 's/-->[[:space:]]*statement-breakpoint//' "$f" | mysqlc "$scratch"
  fi
done
pre_scope=$(q "SELECT COLUMN_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='$scratch' AND TABLE_NAME='userRoleAssignments' AND COLUMN_NAME='scopeType';")
expect "pre-0170 scopeType" "$pre_scope" "enum('global','branch')"
pre_org=$(q "SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='$scratch' AND TABLE_NAME='userRoleAssignments' AND COLUMN_NAME='orgRef';")
expect "pre-0170 orgRef absent" "$pre_org" "0"

echo "== 2. legacy rows, one of every shape =="
q "
INSERT INTO organizations (orgRef, name, status) VALUES
  ('ORG-A','ABC Transport','active'),
  ('ORG-B','XYZ Oilfield','active'),
  ('ORG-S','Suspended Co','suspended');

INSERT INTO organizationMemberships (membershipRef, orgRef, userId, membershipType, status, effectiveFrom, effectiveTo, createdByUserId) VALUES
  -- A: one live membership
  ('MEM-A1','ORG-A',1001,'employee','active','2020-01-01',NULL,1),
  -- B: two live memberships (the ambiguous case)
  ('MEM-B1','ORG-A',1002,'employee','active','2020-01-01',NULL,1),
  ('MEM-B2','ORG-B',1002,'employee','active','2020-01-01',NULL,1),
  -- C: user 1003 has none at all (no row)
  -- A-variant: membership exists but ENDED, so not live -> counts as zero
  ('MEM-D1','ORG-A',1004,'employee','ended','2020-01-01',NULL,1),
  -- A-variant: membership live only in a SUSPENDED organization -> not live
  ('MEM-E1','ORG-S',1005,'employee','active','2020-01-01',NULL,1),
  -- F: one live membership, used for the malformed branch row
  ('MEM-F1','ORG-A',1006,'employee','active','2020-01-01',NULL,1);

INSERT INTO userRoleAssignments (userId, role, scopeType, scopeRef, grantedByUserId, grantedAt, revokedAt, revokedByUserId, revokeReason) VALUES
  (1001,'driver','global',NULL,1,NOW(),NULL,NULL,NULL),                       -- A global
  (1001,'mechanic','branch','BR-A1',1,NOW(),NULL,NULL,NULL),                  -- A branch
  (1002,'management','global',NULL,1,NOW(),NULL,NULL,NULL),                   -- B  -> quarantine
  (1002,'driver','branch','BR-A1',1,NOW(),NULL,NULL,NULL),                    -- B branch -> quarantine
  (1003,'office','global',NULL,1,NOW(),NULL,NULL,NULL),                       -- C -> historical tenant
  (1004,'safety','global',NULL,1,NOW(),NULL,NULL,NULL),                       -- ended membership -> historical tenant
  (1005,'hr','global',NULL,1,NOW(),NULL,NULL,NULL),                           -- suspended org -> historical tenant
  (1006,'dispatcher','branch',NULL,1,NOW(),NULL,NULL,NULL),                   -- F malformed -> quarantine
  (1001,'auditor','global',NULL,1,NOW(),NOW(),1,'left the audit team');       -- R revoked -> untouched
"
pre_total=$(q "SELECT COUNT(*) FROM userRoleAssignments;")
expect "legacy rows seeded" "$pre_total" "9"
pre_revoked_key=$(q "SELECT COALESCE(activeGrantKey,'<null>') FROM userRoleAssignments WHERE role='auditor';")
expect "revoked row has no grant key before" "$pre_revoked_key" "<null>"

echo "== 3. apply 0170, alone =="
sed 's/-->[[:space:]]*statement-breakpoint//' drizzle/0207_organization_scoped_role_grants.sql | mysqlc "$scratch"
echo "applied"

echo "== 4. the schema it produced =="
expect "scopeType widened" \
  "$(q "SELECT COLUMN_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='$scratch' AND TABLE_NAME='userRoleAssignments' AND COLUMN_NAME='scopeType';")" \
  "enum('global','organization','branch','unscoped_legacy')"
expect "orgRef added, nullable" \
  "$(q "SELECT CONCAT(COLUMN_TYPE,'/',IS_NULLABLE) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='$scratch' AND TABLE_NAME='userRoleAssignments' AND COLUMN_NAME='orgRef';")" \
  "varchar(40)/YES"
expect "activeGrantKey regenerated and widened" \
  "$(q "SELECT CONCAT(COLUMN_TYPE,'/',EXTRA) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='$scratch' AND TABLE_NAME='userRoleAssignments' AND COLUMN_NAME='activeGrantKey';")" \
  "varchar(220)/STORED GENERATED"
expect "grant key now includes the organization" \
  "$(q "SELECT CASE WHEN GENERATION_EXPRESSION LIKE '%orgRef%' THEN 'yes' ELSE 'no' END FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='$scratch' AND TABLE_NAME='userRoleAssignments' AND COLUMN_NAME='activeGrantKey';")" \
  "yes"
# The column list, not a row count: information_schema.STATISTICS holds one row
# per indexed COLUMN, so a composite index counts as two and the order matters.
expect "scoped read index covers (userId, orgRef) in that order" \
  "$(q "SELECT GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA='$scratch' AND TABLE_NAME='userRoleAssignments' AND INDEX_NAME='userRoleAssignments_user_org_idx';")" \
  "userId,orgRef"
expect "grant-key uniqueness re-created" \
  "$(q "SELECT CONCAT(NON_UNIQUE,'/',COLUMN_NAME) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA='$scratch' AND TABLE_NAME='userRoleAssignments' AND INDEX_NAME='userRoleAssignments_activeGrantKey_unique';")" \
  "0/activeGrantKey"
expect "shape constraint present" \
  "$(q "SELECT COUNT(*) FROM information_schema.CHECK_CONSTRAINTS WHERE CONSTRAINT_SCHEMA='$scratch' AND TABLE_NAME='userRoleAssignments' AND CONSTRAINT_NAME='userRoleAssignments_scope_shape';")" \
  "1"

echo "== 5. the classification =="
expect "A/global -> ORG-A, organization" \
  "$(q "SELECT CONCAT(scopeType,'/',COALESCE(orgRef,'<null>')) FROM userRoleAssignments WHERE userId=1001 AND role='driver';")" \
  "organization/ORG-A"
expect "A/branch -> ORG-A, branch kept" \
  "$(q "SELECT CONCAT(scopeType,'/',COALESCE(orgRef,'<null>'),'/',COALESCE(scopeRef,'<null>')) FROM userRoleAssignments WHERE userId=1001 AND role='mechanic';")" \
  "branch/ORG-A/BR-A1"
expect "B/global -> quarantined, no organization" \
  "$(q "SELECT CONCAT(scopeType,'/',COALESCE(orgRef,'<null>')) FROM userRoleAssignments WHERE userId=1002 AND role='management';")" \
  "unscoped_legacy/<null>"
expect "B/branch -> quarantined, no organization" \
  "$(q "SELECT CONCAT(scopeType,'/',COALESCE(orgRef,'<null>')) FROM userRoleAssignments WHERE userId=1002 AND role='driver';")" \
  "unscoped_legacy/<null>"
expect "C/no membership -> historical tenant" \
  "$(q "SELECT CONCAT(scopeType,'/',COALESCE(orgRef,'<null>')) FROM userRoleAssignments WHERE userId=1003 AND role='office';")" \
  "organization/default"
expect "ended membership -> historical tenant, not ORG-A" \
  "$(q "SELECT CONCAT(scopeType,'/',COALESCE(orgRef,'<null>')) FROM userRoleAssignments WHERE userId=1004 AND role='safety';")" \
  "organization/default"
expect "suspended organization -> historical tenant, not ORG-S" \
  "$(q "SELECT CONCAT(scopeType,'/',COALESCE(orgRef,'<null>')) FROM userRoleAssignments WHERE userId=1005 AND role='hr';")" \
  "organization/default"
expect "F/malformed branch -> quarantined" \
  "$(q "SELECT CONCAT(scopeType,'/',COALESCE(orgRef,'<null>')) FROM userRoleAssignments WHERE userId=1006 AND role='dispatcher';")" \
  "unscoped_legacy/<null>"

echo "== 6. history is not rewritten =="
expect "revoked row keeps its original scope" \
  "$(q "SELECT CONCAT(scopeType,'/',COALESCE(orgRef,'<null>')) FROM userRoleAssignments WHERE role='auditor';")" \
  "global/<null>"
expect "revoked row still revoked, reason intact" \
  "$(q "SELECT CONCAT(CASE WHEN revokedAt IS NULL THEN 'live' ELSE 'revoked' END,'/',revokeReason) FROM userRoleAssignments WHERE role='auditor';")" \
  "revoked/left the audit team"
expect "no row was deleted" "$(q "SELECT COUNT(*) FROM userRoleAssignments;")" "9"
expect "every live row now names a scope that can be judged" \
  "$(q "SELECT COUNT(*) FROM userRoleAssignments WHERE revokedAt IS NULL AND scopeType='global';")" \
  "0"

echo "== 7. no live grant gained cross-company authority =="
# The only scopeType that reaches every organization is 'global', and the
# backfill created none. Anything it could not attribute is quarantined, and a
# quarantined grant authorizes nowhere.
expect "platform-wide grants created by the backfill" \
  "$(q "SELECT COUNT(*) FROM userRoleAssignments WHERE revokedAt IS NULL AND scopeType='global';")" "0"
expect "quarantined grants" \
  "$(q "SELECT COUNT(*) FROM userRoleAssignments WHERE revokedAt IS NULL AND scopeType='unscoped_legacy';")" "3"

echo "== 8. the constraint refuses what it should =="
for stmt in \
  "INSERT INTO userRoleAssignments (userId,role,scopeType,orgRef,scopeRef,grantedByUserId,grantedAt) VALUES (9001,'driver','organization',NULL,NULL,1,NOW())" \
  "INSERT INTO userRoleAssignments (userId,role,scopeType,orgRef,scopeRef,grantedByUserId,grantedAt) VALUES (9002,'driver','branch',NULL,'B1',1,NOW())" \
  "INSERT INTO userRoleAssignments (userId,role,scopeType,orgRef,scopeRef,grantedByUserId,grantedAt) VALUES (9003,'driver','branch','ORG-A',NULL,1,NOW())" \
  "INSERT INTO userRoleAssignments (userId,role,scopeType,orgRef,scopeRef,grantedByUserId,grantedAt) VALUES (9004,'driver','global','ORG-A',NULL,1,NOW())" \
  ; do
  if q "$stmt" 2>/dev/null; then fail "constraint accepted a malformed scope: $stmt"; fi
done
echo "  ok: four malformed shapes each refused"

echo "== 9. the same role in two organizations, which 0021's key forbade =="
q "INSERT INTO userRoleAssignments (userId,role,scopeType,orgRef,scopeRef,grantedByUserId,grantedAt) VALUES (9100,'driver','organization','ORG-A',NULL,1,NOW());"
q "INSERT INTO userRoleAssignments (userId,role,scopeType,orgRef,scopeRef,grantedByUserId,grantedAt) VALUES (9100,'driver','organization','ORG-B',NULL,1,NOW());"
expect "driver held in two organizations" "$(q "SELECT COUNT(*) FROM userRoleAssignments WHERE userId=9100 AND revokedAt IS NULL;")" "2"
if q "INSERT INTO userRoleAssignments (userId,role,scopeType,orgRef,scopeRef,grantedByUserId,grantedAt) VALUES (9100,'driver','organization','ORG-A',NULL,1,NOW());" 2>/dev/null; then
  fail "a true duplicate grant was accepted"
fi
echo "  ok: a true duplicate is still refused"

echo "== 10. the diagnostic agrees with the rows, and refuses to call this done =="
# This fixture deliberately contains quarantined grants, so the diagnostic MUST
# exit 2 — "the migration is not operationally complete". A diagnostic that
# reported success here would be the one thing worse than no diagnostic.
set +e
diag=$(bash scripts/role-grant-diagnostic.sh "$scratch" 2>&1); diag_exit=$?
set -e
echo "$diag" | sed 's/^/    /'
expect "diagnostic exit code (2 = quarantined grants present)" "$diag_exit" "2"
expect "diagnostic counted the quarantine" \
  "$(echo "$diag" | grep -c 'QUARANTINED                : 3')" "1"
expect "diagnostic counted the historical tenant" \
  "$(echo "$diag" | grep -c 'historical single tenant   : 3')" "1"
expect "diagnostic reported no platform-wide grants" \
  "$(echo "$diag" | grep -c 'platform-wide (global)     : 0')" "1"

mysqlc -e "DROP DATABASE \`$scratch\`;"
echo
echo "== 0170 VERIFIED =="
