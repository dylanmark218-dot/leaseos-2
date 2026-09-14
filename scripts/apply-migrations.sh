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

for f in $(ls drizzle/*.sql | sort); do
  echo "  applying $(basename "$f")"
  sed 's/-->[[:space:]]*statement-breakpoint//' "$f" \
    | mysql -h "$host" -P "$port" -u "$user" ${pass:+-p"$pass"} "$db"
done
echo "migrations applied"
