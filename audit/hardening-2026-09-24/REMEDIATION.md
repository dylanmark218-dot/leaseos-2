# Hardening remediation — 2026-09-24

Works through Wave 1 ("security floor") of `BACKLOG.md` in this directory, the
production-hardening backlog written from a source-only audit of this
repository. That audit could not install dependencies. This pass could, so
every claim below was checked against a real install, typecheck, test run and
production build. The same goes for every "confirmed" in the backlog: each one
acted on here was reproduced first.

## How this was verified

`scripts/ci-gate.sh` was run in full against a local MariaDB 10.11 (the
version CI uses), once before any change and once after.

| | Before | After |
|---|---|---|
| Gate | **failed** at gate 6 | **PASS**, all gates 0–8 |
| Test files | 1 failed, 333 passed | 336 passed |
| Test cases | 1 failed, 4770 passed | 4824 passed |
| `pnpm audit` | 2 critical, 39 high, 61 moderate, 8 low | 0 critical, 0 high, 3 moderate, 0 low |

The failure before any change was `calendarFixtures.test.ts`, which fires three
weeks before a fixture date is passed by the real clock. It would have failed
on `main` too. See **CAL-1** below.

The built server was also booted from a directory holding **only production
dependencies** (`pnpm install --prod`), and probed with curl. See SEC-010.

## Fixed

### SEC-001 — dependency and package-manager security

`pnpm-audit-before.json` reproduces the 2026-09-21 numbers exactly: 2 critical,
39 high. `pnpm-audit-after.json` is the result after this pass.

- **`pnpm` and `add` removed from devDependencies.** Nothing imports either.
  `add` looks like a stray `pnpm add add`. The `pnpm` package alone was 14 of
  the 39 highs, and it was a *second* pnpm, separate from the one
  `packageManager` pins.
- **`packageManager` moved from pnpm 10.4.1 to 10.34.5**, with its sha512. CI
  (`pnpm/action-setup` reads this field), corepack and developers now run one
  version. The lockfile was regenerated with it, and a frozen install passes.
- **vitest 2.1.9 → 3.2.7** (critical: Vitest UI), which also retires the
  vite 5.4 it pulled in. **vite 7.1.9 → 7.3.6.** **express 4.21.2 → 4.22.3.**
  The whole suite passes on vitest 3 unchanged, including the gate's grep for
  skipped `.db.test.ts` files.
- **Transitive packages pinned to patched versions through `pnpm.overrides`**,
  each scoped to the vulnerable range (`tar@<7.5.21`, `rollup@<4.59.0`, …) so
  an override never downgrades anything. Covered: tar, rollup, path-to-regexp,
  picomatch, lodash, lodash-es, form-data, postcss, nanoid 3.x, browserslist,
  body-parser, qs, mermaid, dompurify, uuid, mdast-util-to-hast, @babel/core.
  The existing `tailwindcss>nanoid` override pinned 3.3.7, **itself a
  vulnerable version**. It now pins 3.3.19.
- **CI now fails on any high or critical advisory** (`pnpm audit --audit-level
  high` in `.github/workflows/ci.yml`). It is in the workflow rather than in
  `ci-gate.sh` because it needs the registry, and the gate is meant to run
  offline against a disposable database.

**Accepted, with reason: the 3 moderates left.**

| Package | Why it stays | Exposure |
|---|---|---|
| `vitest` / `@vitest/mocker` 3.2.7 (fixed in 4.1.11) | A major upgrade, and vitest 3 → 4 changes reporters that `ci-gate.sh` greps. Its own change. | Dev only; path traversal through a test's own `vi.mock` redirect. |
| `esbuild` 0.18.20 under `drizzle-kit › @esbuild-kit` (fixed in 0.25) | Forcing 0.25 into drizzle-kit's pinned loader risks breaking migrations tooling. | Dev only; the advisory is esbuild's `serve` mode, which nothing here runs. |

Not done yet from SEC-001: SBOM per release, provenance checking.

### SEC-002 / SEC-003 / NET-002 — SSRF through user-supplied URLs

Confirmed from source. `facilityDirectory.arcgis.inspect` and `importFromLayer`
passed a typed `layerUrl` straight to `fetch()`. `integration.webhookSubscribe`
stored any `https://` URL, and dispatch POSTed to it. Holding the permission
decided *who* could ask. Nothing decided *where* the server would connect.

New: `server/_core/outboundHttp.ts`, the one door out for a URL a person
typed. It refuses:

- anything but https on port 443, and credentials in the URL;
- loopback, RFC1918, link-local (incl. `169.254.169.254` metadata), CGNAT,
  multicast, reserved and documentation ranges, IPv4 and IPv6, including
  IPv4-mapped, NAT64 and 6to4 spellings, plus decimal/hex IPv4 literals
  (WHATWG URL normalises those, and the tests pin it);
- **DNS rebinding.** The check runs inside the socket's own `lookup`, so the
  address checked is the address connected to. If *any* answer is private,
  the name is refused;
- redirects (never followed), responses over a byte cap, and slow peers (a
  wall-clock timeout).

`LEASEOS_OUTBOUND_ALLOWED_HOSTS` can narrow destinations further, but never
widen them. An allowlisted name that resolves to a private address is still
refused.

Wired in: both ArcGIS procedures (a refusal is a `BAD_REQUEST` naming the
reason), webhook delivery (the refusal becomes the delivery's recorded error,
so it stays visible), and webhook subscription (a static check when the URL
is saved, so a private or loopback URL is refused immediately rather than on
first delivery).

Tests: `outboundHttp.test.ts`, 39 cases, no network. The rebinding and
metadata cases go through an injected resolver.

One implementation note worth keeping: Node's `net.BlockList` checks every
IPv4 address against IPv4-*mapped* IPv6 subnets. A `::ffff:0:0/96` rule
therefore blocks the entire IPv4 internet. The first version had exactly that
rule and the tests caught it. There is a comment where it would go.

Not done: an infrastructure egress policy (the module says it is the
application layer, not a replacement for one). `voiceTranscription.ts` also
fetches an `audioUrl`, but nothing calls it today (`engineReachability.test.ts`
lists it as unreached). Route it through this module when it gets a caller.

### SEC-007 / SEC-008 (part) — cross-site requests, headers, rate limit

New: `server/_core/httpHardening.ts`, mounted in `index.ts`.

- **Cross-site request defence.** A state-changing `/api` request must be
  `application/json`, or it gets a 415 before any procedure runs. The
  cookie is `SameSite=None`, and the three content types a cross-site page
  can send without a CORS preflight (`text/plain`, form-urlencoded,
  multipart) are exactly the ones refused. This server answers no preflight,
  so a JSON request from another origin never leaves the attacker's browser.
  This defence needs no configuration and does not depend on proxy headers.
  The only client, the tRPC link in `main.tsx`, always sends JSON. Nothing
  in `client/src` posts any other way (checked: no `sendBeacon`, no raw
  `fetch`, no form posts to `/api`).
- **Origin allowlist, opt-in.** With `LEASEOS_ALLOWED_ORIGINS` set, a request
  carrying an `Origin` header must match it. It is opt-in because behind a
  proxy that rewrites `Host`, the server cannot infer its own public origin,
  and a wrong guess would refuse every mutation.
- **Headers:** `X-Content-Type-Options`, `Referrer-Policy`,
  `Permissions-Policy` (camera/microphone/geolocation for our own origin only,
  since field capture needs them), `Cross-Origin-Resource-Policy`,
  `X-Powered-By` removed, and HSTS outside development, sent only on a request
  that is actually https.
- **No framing ban by default.** The app runs inside an iframe in preview,
  which is why the cookie is `SameSite=None`. `LEASEOS_FRAME_ANCESTORS`
  sends `frame-ancestors` when a deployment knows its embedders.
- **Rate limit on `/api/oauth`**: 60 per minute per client address, per
  process. It is a floor, not the edge limit the backlog asks for.
- **Trusted proxies (NET-001):** `LEASEOS_TRUST_PROXY` sets Express `trust
  proxy`. Without it, `req.ip` and `req.secure` describe the proxy.

Tests: `httpHardening.test.ts`, 14 cases against a real Express server.

Not done from SEC-007/008: a Content-Security-Policy (needs an audit of the
Google Maps and host-runtime scripts first), global and per-route limits for
AI, upload and integration endpoints, and request timeouts.

### SEC-009 — 50 MB body limit on every route

Confirmed. Now 25 MB on `/api/trpc` and 1 MB everywhere else (100 KB for
urlencoded). Only one procedure carries a file, `fieldRoute.evidence.upload`,
and it refuses over 15 MB. 15 MiB of bytes is 20,971,520 base64 characters, so
its `dataBase64` field is now capped at exactly that and refused *before*
decoding. It used to be decoded into a buffer first and measured afterwards.

### SEC-010 — production runtime imports the dev Vite stack

Confirmed by running it. The **original** build, installed with
`pnpm install --prod`, crashes on boot:

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'vite' imported from dist/index.js
```

Making `index.ts` import `./vite` dynamically is not enough on its own. esbuild
inlines a relative dynamic import and hoists that module's external imports,
including `vite.config.ts` and every plugin it imports, to the top of
`dist/index.js`. So:

- `serveStatic` moved to `server/_core/static.ts`;
- `vite.ts` imports `vite` at call time and gives Vite the config as a *path*
  to load, instead of importing it;
- `index.ts` imports `./vite` only on the development branch.

`dist/index.js` now has no static import of any Vite package, only one
`import("vite")`. The same prod-only boot now starts and serves.

### OPS-002 — health and readiness

`GET /health/live` answers 200 without touching any dependency. `GET
/health/ready` runs a `SELECT 1` against the database with a 2-second limit and
returns 200 or 503, naming the failed check but never its error (the endpoint
is unauthenticated). Verified against the prod-only boot: `ready` 200, then 503
with the database stopped, while `live` stayed 200.

Not done: worker, storage and migration-state probes.

### OPS-005 — silent port change in production

Outside development, a busy `PORT` is now a refusal to start. Verified: a
second instance on the same port exits with the reason. Development still
searches for a free port.

### CAL-1 — calendar fixture warning (pre-existing gate failure)

`capitalAssets.test.ts` holds 2026-10-15, -20 and -31 and reads the real
clock, so the three-week warning fired. Reviewed and recorded in
`calendarFixtures.test.ts`'s `REVIEWED` list as clock-independent:

- `acquiredAt` is fixed;
- the schedule takes an explicit `asOf`;
- `dispose` compares only with `acquiredAt` and the period's close state;
- the twin's clock read is on the km path, which is dead here (no distance).

### FLAKE-1 — three suites wrote critical defects onto unit 1 (pre-existing)

Found when a second full gate run on unchanged code failed where the first had
passed. `complianceReadinessC1a` got `critical_defect` and
`mechanic_release_missing` on a truck it had just created.

`workflowOrchestration`, `workflowEndToEnd` and `operationalApiAuthorization`
each record an open critical defect against the literal `unitId` 1. The id
only fills a NOT NULL column (no foreign key, nothing reads it back). But in a
fresh database, unit 1 belongs to whichever suite creates a unit first, which
depends on how concurrently running files interleave. The database left by the
failing run showed unit 1 was C1a's truck, with all three defects on it.

Reproduced deterministically on a fresh database by running `workflowEndToEnd`
then `complianceReadinessC1a` without file parallelism: 1 failed before the
change, 29/29 passed after. The three suites now use a unit id no test
creates. This is on `main` too, independent of the hardening changes.

## Not done in this pass, and why

| Item | Why not here |
|---|---|
| SEC-004 webhook duplicate delivery | Needs a unique `(subscriptionId, eventId, attempt)` index and a claim-before-send state. That is a migration, and it can fail against production rows that are already duplicated. It should be its own reviewed change, with a duplicate check first. **Recommended next.** |
| SEC-005 Bearer fallback from `sessionStorage` | This is the hosting platform's preview sign-in path for browsers that block iframe cookies (`manus-cookie`). Removing it without knowing the production embedding could lock users out. Owner decision: is production ever served in a cookie-blocking iframe? |
| SEC-006 one-year stateless sessions | Needs server-side session records, rotation and revocation: a schema and an auth-flow change. |
| AUTH-*, DOC-*, KEY-*, OPS-001/003/004, MOBILE-*, … | Waves 2–8: larger, and several need owner decisions or external licences. |
