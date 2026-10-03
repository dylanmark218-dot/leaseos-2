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
for f in vite.config.ts tsconfig.json client server shared drizzle .git; do
  [ -e "$RT/$f" ] && fail "the runtime directory must not contain repository source: $f"
done

# ── 3a. S2-FLEET-A: the artifact knows its build without git ─────────────────────────────
# The build identity is embedded by scripts/build-server.mjs. The processes below run with a PATH
# that resolves `node` and nothing else — no git executable — in a directory with no .git, and with
# LEASEOS_BUILD_SHA set to a value that is NOT the build's: the artifact must report the embedded
# identity regardless. Both bundles must carry one, and neither may look it up at runtime.
mkdir -p "$RT/bin" && ln -s "$(command -v node)" "$RT/bin/node"
NODE_ONLY_PATH="$RT/bin"
( PATH="$NODE_ONLY_PATH" command -v git >/dev/null 2>&1 ) && fail "git is resolvable from the node-only PATH"
FAKE_SHA="$(printf '%040d' 0)"
for f in dist/index.js dist/worker.js; do
  # esbuild emits the defined literal single-quoted (`'{"sha":"…"}'`) or double-quoted with escapes.
  grep -qE '(\\?")sha\\?":\\?"[0-9a-f]{40}\\?"' "$f" || fail "$f carries no embedded build identity (was it built by scripts/build-server.mjs?)"
  grep -q 'LEASEOS_BUILD_SHA' "$f" && fail "$f mentions LEASEOS_BUILD_SHA: the build identity is embedded at build time, never read from the runtime environment"
  grep -q 'rev-parse' "$f" && fail "$f mentions rev-parse: the artifact must not look up its build at runtime"
done
note "both bundles carry an embedded build identity; the runtime PATH resolves node only"
# What the identity must be: the sha the build step was given, else the checkout's HEAD. Outside a
# git checkout with no explicit sha there is nothing to compare against, and the server/worker
# agreement check below still holds.
EXPECTED_SHA="${LEASEOS_BUILD_SHA:-$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || true)}"

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
( cd "$RT" && exec env -i PATH="$NODE_ONLY_PATH" HOME="$RT" NODE_ENV=production PORT="$PORT" \
    JWT_SECRET="$SMOKE_JWT_SECRET" VITE_APP_ID="leaseos-prod-smoke" WORKFLOW_WORKER_DISABLED=true \
    LEASEOS_BUILD_SHA="$FAKE_SHA" \
    ${DATABASE_URL:+DATABASE_URL="$DATABASE_URL"} \
    node dist/index.js ) >"$SERVER_LOG" 2>&1 &
SERVER_PID=$!

# The build identity a process reports, from its log: `[build] sha=<40 hex> release=<name> source=artifact …`.
reported_sha() { grep -oE '^\[build\] sha=[0-9a-f]{40} release=[^ ]+ source=artifact' "$1" | head -n 1 | sed -E 's/^\[build\] sha=([0-9a-f]{40}) .*/\1/'; }
# The instanceRef a process registered under, from its log.
registered_ref() { grep -oE "^\[runtime\] registered rt_[0-9a-f-]+ kind=$2" "$1" | head -n 1 | sed -E 's/^\[runtime\] registered (rt_[0-9a-f-]+) .*/\1/'; }
# The registry row for an instanceRef, read with the production dependency the artifact itself uses:
# "<kind> <sha> <1 if not stopped else 0>", or "none".
registry_row() {
  ( cd "$RT" && env -i PATH="$NODE_ONLY_PATH" DATABASE_URL="$DATABASE_URL" node -e '
    const mysql = require("mysql2/promise");
    (async () => {
      const c = await mysql.createConnection(process.env.DATABASE_URL);
      const [r] = await c.query("SELECT runtimeKind, buildSha, (stoppedAt IS NULL) AS live FROM runtimeInstances WHERE instanceRef = ?", [process.argv[1]]);
      await c.end();
      console.log(r.length ? `${r[0].runtimeKind} ${r[0].buildSha} ${r[0].live}` : "none");
    })().catch(e => { console.error(e.message); process.exit(1); });' "$1" )
}

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

# S2-FLEET-A: the server reported the embedded identity — not the one in its environment, and (where
# the checkout can say) the commit that was built — and registered itself before it became ready.
SERVER_SHA="$(reported_sha "$SERVER_LOG")"
[ -n "$SERVER_SHA" ] || { cat "$SERVER_LOG" >&2; fail "the server did not report an embedded build identity ([build] sha=… source=artifact)"; }
[ "$SERVER_SHA" != "$FAKE_SHA" ] || fail "LEASEOS_BUILD_SHA in the runtime environment overrode the embedded build identity"
if [ -n "$EXPECTED_SHA" ]; then
  [ "$SERVER_SHA" = "$EXPECTED_SHA" ] || fail "the server reports build $SERVER_SHA; the build step was given $EXPECTED_SHA"
fi
SERVER_REF="$(registered_ref "$SERVER_LOG" server)"
[ -n "$SERVER_REF" ] || { cat "$SERVER_LOG" >&2; fail "the server did not register itself in the runtime registry before becoming ready"; }
if [ -n "${DATABASE_URL:-}" ]; then
  ROW="$(registry_row "$SERVER_REF")"
  [ "$ROW" = "server $SERVER_SHA 1" ] || fail "runtime registry row for $SERVER_REF is '$ROW', expected 'server $SERVER_SHA 1' (live, this build)"
fi
note "server: build $SERVER_SHA (embedded; environment ignored), registered as $SERVER_REF"

kill -TERM "$SERVER_PID"
for _ in $(seq 1 40); do alive "$SERVER_PID" || break; sleep 0.5; done
alive "$SERVER_PID" && { cat "$SERVER_LOG" >&2; fail "the server did not exit within 20 s of SIGTERM"; }
SERVER_EXIT=0; wait "$SERVER_PID" || SERVER_EXIT=$?
SERVER_PID=""
[ "$SERVER_EXIT" = "0" ] || { cat "$SERVER_LOG" >&2; fail "the server exited $SERVER_EXIT after SIGTERM, expected 0"; }
grep -qiE 'ERR_MODULE_NOT_FOUND|Cannot find (package|module)' "$SERVER_LOG" && { cat "$SERVER_LOG" >&2; fail "the server log reports a missing module"; }
if [ -n "${DATABASE_URL:-}" ]; then
  ROW="$(registry_row "$SERVER_REF")"
  [ "$ROW" = "server $SERVER_SHA 0" ] || fail "after SIGTERM the registry row for $SERVER_REF is '$ROW', expected it marked stopped"
fi
note "server: SIGTERM → exit 0, registry row marked stopped"

# ── 7. The standalone worker ─────────────────────────────────────────────────────────────
[ -n "${DATABASE_URL:-}" ] || fail "DATABASE_URL is required: the worker smoke starts dist/worker.js against a disposable database"
WORKER_LOG="$RT/worker.log"
( cd "$RT" && exec env -i PATH="$NODE_ONLY_PATH" HOME="$RT" NODE_ENV=production DATABASE_URL="$DATABASE_URL" \
    LEASEOS_BUILD_SHA="$FAKE_SHA" \
    node dist/worker.js ) >"$WORKER_LOG" 2>&1 &
WORKER_PID=$!
for _ in $(seq 1 120); do
  grep -q '\[worker\] started' "$WORKER_LOG" 2>/dev/null && break
  alive "$WORKER_PID" || { cat "$WORKER_LOG" >&2; fail "the worker exited before reporting that it started"; }
  sleep 0.5
done
grep -q '\[worker\] started' "$WORKER_LOG" || { cat "$WORKER_LOG" >&2; fail "the worker did not report that it started within 60 s"; }

# S2-FLEET-A: the standalone worker reports EXACTLY the server's identity — the two bundles came from
# one build — and registered itself before claiming work.
WORKER_SHA="$(reported_sha "$WORKER_LOG")"
[ -n "$WORKER_SHA" ] || { cat "$WORKER_LOG" >&2; fail "the worker did not report an embedded build identity"; }
[ "$WORKER_SHA" = "$SERVER_SHA" ] || fail "the worker reports build $WORKER_SHA but the server reported $SERVER_SHA: the two bundles must come from one build"
WORKER_REF="$(registered_ref "$WORKER_LOG" worker)"
[ -n "$WORKER_REF" ] || { cat "$WORKER_LOG" >&2; fail "the worker did not register itself in the runtime registry"; }
ROW="$(registry_row "$WORKER_REF")"
[ "$ROW" = "worker $WORKER_SHA 1" ] || fail "runtime registry row for $WORKER_REF is '$ROW', expected 'worker $WORKER_SHA 1'"
note "worker: build $WORKER_SHA (same as the server), registered as $WORKER_REF"

kill -TERM "$WORKER_PID"
for _ in $(seq 1 40); do alive "$WORKER_PID" || break; sleep 0.5; done
alive "$WORKER_PID" && { cat "$WORKER_LOG" >&2; fail "the worker did not exit within 20 s of SIGTERM"; }
WORKER_EXIT=0; wait "$WORKER_PID" || WORKER_EXIT=$?
WORKER_PID=""
[ "$WORKER_EXIT" = "0" ] || { cat "$WORKER_LOG" >&2; fail "the worker exited $WORKER_EXIT after SIGTERM, expected 0"; }
grep -qiE 'ERR_MODULE_NOT_FOUND|Cannot find (package|module)' "$WORKER_LOG" && { cat "$WORKER_LOG" >&2; fail "the worker log reports a missing module"; }
ROW="$(registry_row "$WORKER_REF")"
[ "$ROW" = "worker $WORKER_SHA 0" ] || fail "after SIGTERM the registry row for $WORKER_REF is '$ROW', expected it marked stopped"
note "worker: started, SIGTERM → exit 0, registry row marked stopped"

echo "prod-runtime-smoke: PASS — dist/index.js and dist/worker.js boot with production dependencies only, report one embedded build identity ($SERVER_SHA) without git, and register in the runtime registry"
