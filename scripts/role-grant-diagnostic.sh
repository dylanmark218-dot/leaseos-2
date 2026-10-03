#!/usr/bin/env bash
# B23.1A — what the role table actually holds, per organization.
#
# Run this BEFORE and AFTER migration 0170. It is read-only: no UPDATE, no
# INSERT, no DELETE anywhere in this file.
#
# The number that matters is `unscoped_legacy`. Those are grants 0170 refused to
# attribute because their holder already belonged to more than one company when
# organization scope arrived, so no organization could be inferred without
# guessing whose authority to hand over. They authorize NOTHING, anywhere, until
# an administrator re-grants them per organization.
#
#   IF unscoped_legacy > 0
#   THEN review and re-grant before considering the migration operational.
#
# Those people have lost access. That is the safe direction, and it is the
# direction this migration was written to fail in — but it is still an outage
# for them, and they should be told before it happens rather than after.
#
# Deliberately counts and organization references only. No names, no email
# addresses, no employment detail: an operator running a migration check does
# not need to know who anybody is, and a diagnostic that prints staff records
# becomes a reason not to run it.
#
# Usage: DATABASE_URL=mysql://... bash scripts/role-grant-diagnostic.sh [database]
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"
proto="${DATABASE_URL#mysql://}"
creds="${proto%%@*}"; hostpart="${proto#*@}"
user="${creds%%:*}"; pass="${creds#*:}"; [ "$pass" = "$creds" ] && pass=""
hostport="${hostpart%%/*}"; db="${1:-${hostpart#*/}}"
host="${hostport%%:*}"; port="${hostport#*:}"; [ "$port" = "$host" ] && port=3306

mysqlc() { mysql --default-character-set=utf8mb4 -h "$host" -P "$port" -u "$user" ${pass:+-p"$pass"} "$db" "$@"; }
scalar() { mysqlc -N -B -e "$1"; }

# Pre-0170 databases have no orgRef column. Say so rather than erroring: this
# script is meant to be run on both sides of the migration.
has_org=$(scalar "SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='$db' AND TABLE_NAME='userRoleAssignments' AND COLUMN_NAME='orgRef';")

echo "LeaseOS role-grant diagnostic — database: $db"
echo

if [ "$has_org" = "0" ]; then
  echo "SCHEMA: pre-0170 (no orgRef column)"
  echo
  echo "  active grants              : $(scalar "SELECT COUNT(*) FROM userRoleAssignments WHERE revokedAt IS NULL;")"
  echo "  revoked grants (history)   : $(scalar "SELECT COUNT(*) FROM userRoleAssignments WHERE revokedAt IS NOT NULL;")"
  echo
  echo "PREDICTED CLASSIFICATION (what 0170 will do — nothing is written by this script):"
  live_membership="om.status='active' AND o.status='active' AND om.effectiveFrom <= NOW() AND (om.effectiveTo IS NULL OR om.effectiveTo > NOW())"
  count_live="(SELECT COUNT(DISTINCT om.orgRef) FROM organizationMemberships om JOIN organizations o ON o.orgRef=om.orgRef WHERE om.userId=ra.userId AND $live_membership)"
  echo "  A  one live membership     : $(scalar "SELECT COUNT(*) FROM userRoleAssignments ra WHERE ra.revokedAt IS NULL AND $count_live = 1;") (attributed — authority preserved, now scoped)"
  echo "  B  several memberships     : $(scalar "SELECT COUNT(*) FROM userRoleAssignments ra WHERE ra.revokedAt IS NULL AND $count_live > 1;") (QUARANTINED — these lose access)"
  echo "  C  no live membership      : $(scalar "SELECT COUNT(*) FROM userRoleAssignments ra WHERE ra.revokedAt IS NULL AND $count_live = 0;") (historical single tenant)"
  echo "  F  malformed branch grant  : $(scalar "SELECT COUNT(*) FROM userRoleAssignments WHERE revokedAt IS NULL AND scopeType='branch' AND scopeRef IS NULL;") (QUARANTINED)"
  echo
  echo "  Users who would be quarantined:"
  mysqlc -N -B -e "SELECT CONCAT('    userId=', ra.userId, ' role=', ra.role, ' memberships=', $count_live) FROM userRoleAssignments ra WHERE ra.revokedAt IS NULL AND ($count_live > 1 OR (ra.scopeType='branch' AND ra.scopeRef IS NULL)) ORDER BY ra.userId, ra.role;" || true
  exit 0
fi

echo "SCHEMA: post-0170"
echo
total=$(scalar "SELECT COUNT(*) FROM userRoleAssignments WHERE revokedAt IS NULL;")
quarantined=$(scalar "SELECT COUNT(*) FROM userRoleAssignments WHERE revokedAt IS NULL AND scopeType='unscoped_legacy';")
platform=$(scalar "SELECT COUNT(*) FROM userRoleAssignments WHERE revokedAt IS NULL AND scopeType='global';")
historical=$(scalar "SELECT COUNT(*) FROM userRoleAssignments WHERE revokedAt IS NULL AND orgRef='default';")

echo "  active grants              : $total"
echo "  revoked grants (history)   : $(scalar "SELECT COUNT(*) FROM userRoleAssignments WHERE revokedAt IS NOT NULL;")"
echo "  organization-scoped        : $(scalar "SELECT COUNT(*) FROM userRoleAssignments WHERE revokedAt IS NULL AND scopeType='organization';")"
echo "  branch-scoped              : $(scalar "SELECT COUNT(*) FROM userRoleAssignments WHERE revokedAt IS NULL AND scopeType='branch';")"
echo "  historical single tenant   : $historical  (orgRef='default' — authorizes only where there is no organization at all)"
echo "  platform-wide (global)     : $platform  (crosses every organization by design; the backfill creates none)"
echo "  QUARANTINED                : $quarantined  (unscoped_legacy — authorizes nowhere)"
echo
echo "  Grants per organization:"
mysqlc -N -B -e "SELECT CONCAT('    ', COALESCE(orgRef,'<none>'), '  ', COUNT(*), ' grant(s), ', COUNT(DISTINCT userId), ' holder(s)') FROM userRoleAssignments WHERE revokedAt IS NULL GROUP BY orgRef ORDER BY orgRef;" || true

if [ "$quarantined" != "0" ]; then
  echo
  echo "  QUARANTINED GRANTS — each needs an explicit re-grant in a named organization."
  echo "  (identifier and role only; resolve through records.roles.grant, never by UPDATE)"
  mysqlc -N -B -e "SELECT CONCAT('    id=', id, ' userId=', userId, ' role=', role, ' grantedAt=', grantedAt) FROM userRoleAssignments WHERE revokedAt IS NULL AND scopeType='unscoped_legacy' ORDER BY userId, role;" || true
fi

echo
if [ "$quarantined" != "0" ]; then
  echo "RESULT: $quarantined grant(s) quarantined — the migration is NOT operationally complete."
  echo "        Review and re-grant them before treating this deployment as migrated."
  exit 2
fi
if [ "$platform" != "0" ]; then
  echo "RESULT: $platform platform-wide grant(s) exist. The backfill creates none, so these"
  echo "        were granted deliberately. Confirm that is intended — they cross every organization."
  exit 3
fi
echo "RESULT: no quarantined grants, no platform-wide grants. Migration is operationally complete."
