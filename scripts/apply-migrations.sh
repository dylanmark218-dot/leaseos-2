#!/usr/bin/env bash
# Apply every migration in order against DATABASE_URL.
# Drizzle separates statements with `--> statement-breakpoint`, which the
# mysql client does not understand, so it is stripped first.
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"
proto="${DATABASE_URL#mysql://}"
creds="${proto%%@*}"; hostpart="${proto#*@}"
user="${creds%%:*}"; pass="${creds#*:}"; [ "$pass" = "$creds" ] && pass=""
hostport="${hostpart%%/*}"; db="${hostport#*/}"; db="${hostpart#*/}"
host="${hostport%%:*}"; port="${hostport#*:}"; [ "$port" = "$host" ] && port=3306

mysqlc() { mysql -h "$host" -P "$port" -u "$user" ${pass:+-p"$pass"} "$db"; }

# COMPOUND STATEMENTS NEED A DELIMITER (recovered from the Chat 5 Academy
# runner). A trigger with a `BEGIN … END` body contains internal semicolons;
# the mysql client splits on `;` lexically and knows nothing about BEGIN/END,
# so without a DELIMITER directive it sends a truncated statement. The test is
# `^BEGIN$`, NOT `CREATE TRIGGER`: the single-statement triggers in 0061/0062
# apply correctly under the default `;` and break if wrapped in DELIMITER.
for f in $(ls drizzle/*.sql | sort); do
  echo "  applying $(basename "$f")"
  if grep -qE '^BEGIN$' "$f"; then
    { printf 'DELIMITER $$\n'
      sed -e 's/-->[[:space:]]*statement-breakpoint//' -e 's/^END;$/END$$/' "$f"
      printf '\nDELIMITER ;\n'
    } | mysqlc
  else
    sed 's/-->[[:space:]]*statement-breakpoint//' "$f" | mysqlc
  fi
done

# Academy certificate retention is a legal/compliance invariant, not an optional
# convenience. The recovered 0108 migration installs the guard; a migration
# run that silently omits the trigger is not complete.
academy_trigger_count=$(mysql -N -B -h "$host" -P "$port" -u "$user" ${pass:+-p"$pass"} "$db" \
  -e "SELECT COUNT(*) FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE() AND TRIGGER_NAME = 'academyCertificates_retention_guard'")
if [ "$academy_trigger_count" != "1" ]; then
  echo "migration verification failed: academyCertificates_retention_guard missing or duplicated (count=$academy_trigger_count)" >&2
  exit 1
fi

echo "migrations applied and Academy retention guard verified"
