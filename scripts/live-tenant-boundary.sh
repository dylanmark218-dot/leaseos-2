#!/usr/bin/env bash
# The tenant boundary, checked against a RUNNING server over real HTTP.
#
# WHY THIS EXISTS. Every tenant-scope suite in `server/` drives the router through
# `appRouter.createCaller`, which builds the context by hand. That is the right
# tool for the boundary logic, but it skips the HTTP transport, the session
# cookie, `authenticateRequest`, the superjson transformer and the whole tRPC
# middleware chain — so a boundary that holds in those suites could still be
# reachable by a real request if any of that layer resolved identity differently.
# Nothing in the gate closed that gap: `prod-runtime-smoke.sh` proves the artifact
# BOOTS, and asks it only for `auth.me` as an anonymous caller.
#
# This drives the same built artifact a deployment runs, with minted session JWTs
# for two people in two organizations, and asks the questions an attacker asks:
# can A name B's device, B's evidence, B's vendor, B's capture reference, B's
# queued package? Each check demands the same thing the suites do — a foreign id
# answered exactly as a fictional one, and the caller's own work still working.
#
# NOT PART OF THE GATE, deliberately: it needs a free port, a disposable database
# and an object store, and it takes about a minute. Run it before a release or
# after touching authorization, identity or any scope helper.
#
# Usage: DATABASE_URL=mysql://user:pass@host:port/db bash scripts/live-tenant-boundary.sh
#
# The database named in DATABASE_URL is DROPPED and recreated. Point it at a
# disposable database. `pnpm build` must have run — this checks the artifact, not
# the sources, and will say so rather than quietly building one.
#
# ON THE STORAGE STUB. `server/storage.ts` has no local mode; it always calls the
# Forge HTTP API. The unit suites mock the module, which cannot help a server in
# another process, so a double stands in. It makes no authorization decision and
# ignores the bearer token on purpose: nothing in it can stand in for the boundary
# being measured. If the evidence upload path ever stops going through storage,
# delete the stub rather than teaching it more.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

: "${DATABASE_URL:?DATABASE_URL is required}"
proto="${DATABASE_URL#mysql://}"
creds="${proto%%@*}"; hostpart="${proto#*@}"
user="${creds%%:*}"; pass="${creds#*:}"; [ "$pass" = "$creds" ] && pass=""
hostport="${hostpart%%/*}"; db="${hostpart#*/}"
host="${hostport%%:*}"; port="${hostport##*:}"; [ "$port" = "$host" ] && port=3306
MYSQL=(mysql -h "$host" -P "$port" -u "$user")
[ -n "$pass" ] && MYSQL+=("-p$pass")

fail() { echo "live-tenant-boundary: FAIL — $*" >&2; exit 1; }
note() { echo "live-tenant-boundary: $*"; }

[ -f dist/index.js ] || fail "dist/index.js is missing — run pnpm build first (this checks the artifact, not the sources)"
command -v curl >/dev/null || fail "curl is required"

SERVER_PID=""; STUB_PID=""
cleanup() {
  [ -n "$SERVER_PID" ] && kill -KILL "$SERVER_PID" 2>/dev/null || true
  [ -n "$STUB_PID" ] && kill -KILL "$STUB_PID" 2>/dev/null || true
}
trap cleanup EXIT

free_port() { node -e "const s=require('node:net').createServer();s.listen(0,()=>{console.log(s.address().port);s.close();})"; }

note "recreating $db"
"${MYSQL[@]}" -e "DROP DATABASE IF EXISTS \`$db\`; CREATE DATABASE \`$db\`;"
DATABASE_URL="$DATABASE_URL" bash scripts/apply-migrations.sh >/dev/null
note "migrations applied"

STUB_PORT="$(free_port)"
node scripts/live-tenant-boundary-storage-stub.mjs "$STUB_PORT" >/dev/null 2>&1 &
STUB_PID=$!
for _ in $(seq 1 40); do
  curl -fsS "http://127.0.0.1:$STUB_PORT/v1/storage/presign/put?path=probe" >/dev/null 2>&1 && break
  sleep 0.25
done
curl -fsS "http://127.0.0.1:$STUB_PORT/v1/storage/presign/put?path=probe" >/dev/null 2>&1 \
  || fail "the storage stub did not start on $STUB_PORT"
note "storage stub on $STUB_PORT"

PORT="$(free_port)"
SECRET="$(node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))")"
APP_ID="leaseos-live-tenant-boundary"
NODE_ENV=production PORT="$PORT" DATABASE_URL="$DATABASE_URL" JWT_SECRET="$SECRET" \
  VITE_APP_ID="$APP_ID" BUILT_IN_FORGE_API_URL="http://127.0.0.1:$STUB_PORT" \
  BUILT_IN_FORGE_API_KEY="stub-key" WORKFLOW_WORKER_DISABLED=true \
  node dist/index.js >/dev/null 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 60); do
  curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 && break
  sleep 0.5
done
curl -fsS "http://127.0.0.1:$PORT/healthz" | grep -q '"status":"ok"' \
  || fail "the server did not become healthy on $PORT"
note "server on $PORT (production artifact)"

SMOKE_BASE="http://127.0.0.1:$PORT" JWT_SECRET="$SECRET" VITE_APP_ID="$APP_ID" \
  DATABASE_URL="$DATABASE_URL" node scripts/live-tenant-boundary.mjs

note "PASS — every tenant boundary held over real HTTP"
