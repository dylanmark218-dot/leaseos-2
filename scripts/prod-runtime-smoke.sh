#!/usr/bin/env bash
# P0-C — the production artifact boots with production dependencies only.
#
# WHY THIS EXISTS. `pnpm build` bundles server/_core/index.ts with --packages=external, so every
# bare import left in dist/index.js is resolved at runtime from node_modules. In the repository
# that node_modules holds the development install, so a production entrypoint that imported Vite
# — as it did until P0-C — booted on every developer machine and in every CI run, and failed with
# ERR_MODULE_NOT_FOUND the first time it ran where only `dependencies` were installed. Nothing in
# the gate could see it, because nothing in the gate ever ran the artifact anywhere but the
# checkout.
#
# WHAT IT DOES. Builds nothing: the gate has just built. It creates a runtime directory OUTSIDE
# the repository — so Node cannot walk up into the development node_modules — holding only what a
# deployment ships (dist/, package.json, pnpm-lock.yaml and the pnpm patches the lockfile names),
# installs production dependencies there from the local store (offline: a missing package is a
# failure, not a download), proves the development tools are unresolvable from it, classifies
# every external import of both bundles against package.json, starts the server with the
# documented start command and production configuration, probes liveness, readiness, the built
# SPA, the SPA fallback, an asset and the tRPC mount, and stops it with SIGTERM. Then the
# standalone worker: start, reach the started state, SIGTERM, clean exit.
#
# This boot is authoritative. server/productionDependencyBoundary.test.ts is the static early
# warning over the source import graph.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

fail() { echo "prod-runtime-smoke: FAIL — $*" >&2; exit 1; }
note() { echo "prod-runtime-smoke: $*"; }

# ── 1. The artifact contract: what must ship ──────────────────────────────────────────────
for f in dist/index.js dist/worker.js dist/public/index.html; do
  [ -f "$f" ] || fail "build artifact incomplete: $f is required (run pnpm build first)"
done

# ── 2. Production starts the built JavaScript, never the sources ─────────────────────────
START="$(node -p "require('./package.json').scripts.start")"
WORKER="$(node -p "require('./package.json').scripts.worker")"
[ "$START" = "NODE_ENV=production node dist/index.js" ] \
  || fail "package.json 'start' must be 'NODE_ENV=production node dist/index.js' (was: $START)"
[ "$WORKER" = "NODE_ENV=production node dist/worker.js" ] \
  || fail "package.json 'worker' must be 'NODE_ENV=production node dist/worker.js' (was: $WORKER)"

# ── 3. A runtime directory the development install cannot reach ──────────────────────────
RT="$(mktemp -d "${TMPDIR:-/tmp}/leaseos-prod-runtime.XXXXXX")"
SERVER_PID=""; WORKER_PID=""
cleanup() {
  [ -n "$SERVER_PID" ] && kill -KILL "$SERVER_PID" 2>/dev/null || true
  [ -n "$WORKER_PID" ] && kill -KILL "$WORKER_PID" 2>/dev/null || true
  rm -rf "$RT"
}
trap cleanup EXIT
case "$RT" in "$ROOT"/*) fail "runtime directory $RT is inside the repository";; esac
d="$RT"
while [ "$d" != "/" ]; do
  d="$(dirname "$d")"
  [ -e "$d/node_modules" ] && fail "an ancestor of the runtime directory holds a node_modules: $d/node_modules"
done
note "runtime directory $RT (outside $ROOT, no ancestor node_modules)"

cp package.json pnpm-lock.yaml "$RT/"
[ -d patches ] && cp -r patches "$RT/patches"
cp -r dist "$RT/dist"
for f in vite.config.ts tsconfig.json client server shared drizzle; do
  [ -e "$RT/$f" ] && fail "the runtime directory must not contain repository source: $f"
done

( cd "$RT" && pnpm install --prod --frozen-lockfile --offline --ignore-scripts >"$RT/install.log" 2>&1 ) \
  || { cat "$RT/install.log" >&2; fail "production-only install failed (see above)"; }
note "production dependencies installed: $(ls "$RT/node_modules" | grep -vc '^\.') top-level packages, devDependencies skipped"

# ── 4. The development tools must not be resolvable from the runtime ─────────────────────
DEV_ONLY="vite @vitejs/plugin-react @tailwindcss/vite @builder.io/vite-plugin-jsx-loc vite-plugin-manus-runtime vitest tsx typescript esbuild drizzle-kit"
for p in $DEV_ONLY; do
  if ( cd "$RT" && env -i PATH="$PATH" node --input-type=module -e "import.meta.resolve('$p')" >/dev/null 2>&1 ); then
    fail "development package '$p' is resolvable from the production runtime"
  fi
done
note "development tools unresolvable: $DEV_ONLY"

# ── 5. Every external import of both bundles is a production dependency or a builtin ─────
( cd "$RT" && node - <<'EOF'
const fs = require("node:fs");
const { builtinModules } = require("node:module");
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const deps = new Set(Object.keys(pkg.dependencies ?? {}));
const dev = new Set(Object.keys(pkg.devDependencies ?? {}));
const builtins = new Set(builtinModules.flatMap(m => [m, `node:${m}`]));
const nameOf = s => s.startsWith("@") ? s.split("/").slice(0, 2).join("/") : s.split("/")[0];
let bad = 0;
for (const f of ["dist/index.js", "dist/worker.js"]) {
  const src = fs.readFileSync(f, "utf8");
  const specs = new Set();
  for (const m of src.matchAll(/^import\s+(?:[^"';]+?\s+from\s+)?["']([^"']+)["'];?\s*$/gm)) specs.add(m[1]);
  for (const s of specs) {
    if (builtins.has(s) || builtins.has(nameOf(s))) continue;
    const n = nameOf(s);
    if (dev.has(n)) { console.error(`${f}: imports development-only package ${s}`); bad++; }
    else if (!deps.has(n)) { console.error(`${f}: imports ${s}, which is not a production dependency`); bad++; }
  }
  console.log(`prod-runtime-smoke: ${f}: ${specs.size} external specifiers, all production dependencies or builtins`);
}
process.exit(bad ? 1 : 0);
EOF
) || fail "a bundle imports a package production does not install"

# ── 6. The server: documented command, production configuration, probes, SIGTERM ─────────
command -v curl >/dev/null || fail "curl is required"
PORT="$(node -e "const s=require('node:net').createServer();s.listen(0,()=>{console.log(s.address().port);s.close();})")"
BASE="http://127.0.0.1:$PORT"
SMOKE_JWT_SECRET="$(node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))")"
SERVER_LOG="$RT/server.log"
# `env -i`: nothing from this shell leaks in — no NODE_PATH, no NODE_OPTIONS, no .env of the
# checkout (dotenv reads the runtime directory, which has none). The worker is disabled here so a
# server failure and a worker failure are reported separately; the worker boots on its own below.
( cd "$RT" && exec env -i PATH="$PATH" HOME="$RT" NODE_ENV=production PORT="$PORT" \
    JWT_SECRET="$SMOKE_JWT_SECRET" VITE_APP_ID="leaseos-prod-smoke" WORKFLOW_WORKER_DISABLED=true \
    ${DATABASE_URL:+DATABASE_URL="$DATABASE_URL"} \
    node dist/index.js ) >"$SERVER_LOG" 2>&1 &
SERVER_PID=$!

alive() { kill -0 "$1" 2>/dev/null; }
for _ in $(seq 1 120); do
  curl -fsS "$BASE/healthz" >/dev/null 2>&1 && break
  alive "$SERVER_PID" || { cat "$SERVER_LOG" >&2; fail "server exited before answering /healthz"; }
  sleep 0.5
done
curl -fsS "$BASE/healthz" | grep -q '"status":"ok"' || fail "/healthz did not answer {\"status\":\"ok\"}"
READY="$(curl -sS -o "$RT/readyz.json" -w '%{http_code}' "$BASE/readyz")"
[ "$READY" = "200" ] && grep -q '"status":"ready"' "$RT/readyz.json" || fail "/readyz answered HTTP $READY $(cat "$RT/readyz.json")"
curl -fsS -o "$RT/root.html" "$BASE/" || fail "GET / failed"
cmp -s "$RT/root.html" dist/public/index.html || fail "GET / did not serve dist/public/index.html"
curl -fsS -o "$RT/spa.html" "$BASE/dispatch/board/42" || fail "GET /dispatch/board/42 (SPA fallback) failed"
cmp -s "$RT/spa.html" dist/public/index.html || fail "the SPA fallback did not serve dist/public/index.html"
ASSET="$(ls dist/public/assets | head -n 1)"
[ -n "$ASSET" ] || fail "dist/public/assets is empty"
curl -fsS -o /dev/null "$BASE/assets/$ASSET" || fail "GET /assets/$ASSET failed"
curl -fsS "$BASE/api/trpc/auth.me" | grep -q '"json":null' || fail "the tRPC mount did not answer auth.me for an anonymous caller"
grep -q "Server running on" "$SERVER_LOG" || fail "the server did not report that it is running"
alive "$SERVER_PID" || fail "the server died after answering the probes"
note "server: /healthz ok, /readyz ready, / and SPA fallback serve the built index.html, /assets/$ASSET 200, tRPC auth.me answers"

kill -TERM "$SERVER_PID"
for _ in $(seq 1 40); do alive "$SERVER_PID" || break; sleep 0.5; done
alive "$SERVER_PID" && { cat "$SERVER_LOG" >&2; fail "the server did not exit within 20 s of SIGTERM"; }
SERVER_EXIT=0; wait "$SERVER_PID" || SERVER_EXIT=$?
SERVER_PID=""
[ "$SERVER_EXIT" = "0" ] || { cat "$SERVER_LOG" >&2; fail "the server exited $SERVER_EXIT after SIGTERM, expected 0"; }
grep -qiE 'ERR_MODULE_NOT_FOUND|Cannot find (package|module)' "$SERVER_LOG" && { cat "$SERVER_LOG" >&2; fail "the server log reports a missing module"; }
note "server: SIGTERM → exit 0"

# ── 7. The standalone worker ─────────────────────────────────────────────────────────────
[ -n "${DATABASE_URL:-}" ] || fail "DATABASE_URL is required: the worker smoke starts dist/worker.js against a disposable database"
WORKER_LOG="$RT/worker.log"
( cd "$RT" && exec env -i PATH="$PATH" HOME="$RT" NODE_ENV=production DATABASE_URL="$DATABASE_URL" \
    node dist/worker.js ) >"$WORKER_LOG" 2>&1 &
WORKER_PID=$!
for _ in $(seq 1 120); do
  grep -q '\[worker\] started' "$WORKER_LOG" 2>/dev/null && break
  alive "$WORKER_PID" || { cat "$WORKER_LOG" >&2; fail "the worker exited before reporting that it started"; }
  sleep 0.5
done
grep -q '\[worker\] started' "$WORKER_LOG" || { cat "$WORKER_LOG" >&2; fail "the worker did not report that it started within 60 s"; }
kill -TERM "$WORKER_PID"
for _ in $(seq 1 40); do alive "$WORKER_PID" || break; sleep 0.5; done
alive "$WORKER_PID" && { cat "$WORKER_LOG" >&2; fail "the worker did not exit within 20 s of SIGTERM"; }
WORKER_EXIT=0; wait "$WORKER_PID" || WORKER_EXIT=$?
WORKER_PID=""
[ "$WORKER_EXIT" = "0" ] || { cat "$WORKER_LOG" >&2; fail "the worker exited $WORKER_EXIT after SIGTERM, expected 0"; }
grep -qiE 'ERR_MODULE_NOT_FOUND|Cannot find (package|module)' "$WORKER_LOG" && { cat "$WORKER_LOG" >&2; fail "the worker log reports a missing module"; }
note "worker: started, SIGTERM → exit 0"

echo "prod-runtime-smoke: PASS — dist/index.js and dist/worker.js boot with production dependencies only"
