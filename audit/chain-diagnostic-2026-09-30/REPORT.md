# Chain diagnostic — 2026-09-30

`main` at `4a7ffa7`. Every gate, run locally from an empty database; six independent read-only
lenses over the tree (gates, migrations, wiring, security, tests, runtime); and every claim that
made it into §2 was then re-read against the file it names before it was written down here.

Each finding carries **who verified it**. "Verified: reading" means I opened the cited file and
the claim is literally true of the code as written, or I ran the command shown. "Verified: lens
+ 2 refuters" means the automated pass and both adversarial re-reads agreed. "Reported, not yet
verified" means a lens raised it and no one has re-read it; those are listed in §4, not §2, so
that the ranking in §2 contains nothing anyone has to take on trust.

---

## 0. The one thing that is not in the tree

**GitHub Actions has not run the gate since 2026-09-25 15:29.** Every `CI` job since — runs 477
through 503, on this branch and on `main` — completes in 3–5 seconds with `runner_id: 0`, no
steps, and no logs. A re-run of run 475 (`main` at `e08a135`, which had **passed** in 5 minutes
earlier the same day) fails the same way, so it is not any commit's doing. Dependabot's separate
workflow ran normally on 2026-09-28, so Actions is not globally off; the `CI` job specifically
dies before a runner attaches. `.github/workflows/ci.yml` is byte-identical to the last green run.

**Consequence: 30 commits merged to `main` between `6b31d58` and `4a7ffa7` with no CI.** Their
only verification is the local run in §1, which is why §1 exists.

What to check, in order: *Settings → Billing and plans → Actions* (minutes or spending limit),
*Settings → Actions → General* (a runner or policy restriction), then githubstatus.com. Nothing in
a commit can allocate a runner.

---

## 1. What the chain is, and what it says today

### 1.1 The gate (`scripts/ci-gate.sh`), in order

| Gate | Enforces | On `4a7ffa7`, local |
|---|---|---|
| 0a | `node scripts/check-version-truth.mjs` — runtime version matches what the repo declares | ✅ |
| 0 | migration slots `0016`/`0017` remain empty | ✅ |
| 1 | `DROP DATABASE` / `CREATE DATABASE`, plus a `<db>_widgets` companion | ✅ |
| 2 | `scripts/apply-migrations.sh` — every `drizzle/*.sql` in `ls | sort` order, then the Academy retention guard | ✅ 181 files |
| 3 | `scripts/verify-parity.sh` — schema.ts tables ↔ database tables | ✅ |
| 4 | `tsc --noEmit`; then test-file type errors counted against a pinned ceiling of **0** | ✅ 0 / 0 |
| 5 | no `\w+: protectedProcedure` in `server/*Router*.ts`, `routers.ts`, `recordsRouter.ts` | ✅ 0 |
| 6 | `vitest run --reporter=basic`; then no `.db.test.ts` suite may report `↓` skipped | 394 files, **5 955 passed**, 3 skipped, **1 failed** |
| 7 | `pnpm build` — `dist/index.js` (3.3 MB) + `dist/worker.js` (468 KB) | ✅ |
| 7b | `portalRouter.ts` mounts no `roleProcedure` | ✅ 36 external, 0 role |
| 7c | `inboundRouter` mounts no `roleProcedure`/`externalProcedure`, and ≥1 `integrationProcedure` | ✅ 2 integration, 0 wrong-kind |
| 8 | `LEASEOS_CURRENT_STATE.md` is byte-identical to what `scripts/current-state.sh` regenerates | ✅ current |

The one gate-6 failure is `widgetPersistence.db.test.ts › creates the cascade and the per-owner
uniqueness`, at its 5 000 ms timeout. Issue #46 measures the suite at 4.2–4.9 s in isolation, so
under the full suite's parallel load scheduling noise decides it. It reproduces on untouched
`main` and on every branch this session has touched. **Because `set -e` stops the script at gate
6, gates 7–8 had never run locally until this diagnostic ran them by hand** — remote CI was the
only thing that ever exercised them, and remote CI has been dead for five days.

### 1.2 The runtime chain

```
boot   server/_core/index.ts
         env.ts (validated) → express → /api/trpc (createExpressMiddleware) → routers.ts (appRouter)
         listen.ts: resolveListenPort → listenOnPort (bind error → rejection → exit 1)
         health.ts: readiness state
         worker started only after listen succeeds; closed on boot failure
request  roleProcedure | externalProcedure (portal) | integrationProcedure (inbound) | publicProcedure/adminProcedure (system)
           → router handler → service → db.ts (getDb) → drizzle → MariaDB
           tenant boundary: actingScopeFor / resolveActingScope / financeScopeFor / assertCallerOwnsEntity / ownershipScopeWhere
worker   server/_core/worker.ts: outbox drain loop → webhook retry sweep (claim → send via egressPost → finish) → purges
```

---

## 2. Where it breaks

Ranked. Nothing here is on trust.

### HIGH

**H1 — The refresh cookie can never reach the endpoint that redeems it.**
`server/_core/cookies.ts:10` — `REFRESH_COOKIE_PATH = "/api/auth"`.
tRPC is mounted at `/api/trpc` (`server/_core/index.ts:44`) and **no route exists under
`/api/auth`** (`grep -rn '"/api/auth' server/` finds only the constant). The client redeems at
`/api/trpc/auth.refresh` (`client/src/lib/sessionRefresh.ts:136`). A browser sends a cookie only
to request paths that begin with its `Path`; `/api/auth` is not a prefix of
`/api/trpc/auth.refresh`. With S1's 15-minute access credential, the browser therefore cannot
rotate a session. `sessionCookiePolicy.test.ts:55–56` **pins `/api/auth`**, so the suite guards
the defect. *Fix:* the path must be a prefix of the redeeming route — `/api/trpc/auth` at the
narrowest — and the test must assert that relationship, not the literal. *Verified: reading.*

**H2 — Gate 6's skipped-suite check has never been able to fire in GitHub Actions.**
`scripts/ci-gate.sh` — `grep -E '^ *↓ .*\.db\.test\.ts'` over the vitest output.
vitest (via tinyrainbow) treats `CI=true` as colour-capable even through a pipe, so in Actions the
line is `\e[2m\e[90m↓\e[39m\e[22m server/x.db.test.ts …` and `^ *↓` matches nothing. Reproduced
locally: `CI=true GITHUB_ACTIONS=true npx vitest run <suite> --reporter=basic | grep -cE '^ *↓ .*\.db\.test\.ts'`
→ **0** while the suite visibly skips. The check that exists to catch "a suite that quietly stopped
running" is itself quietly not running. *Fix:* `FORCE_COLOR=0`/`NO_COLOR=1` on the vitest
invocation, or strip ANSI before the grep, and pin the check with a deliberately-skipped fixture
suite. *Verified: reading + reproduced.*

**H3 — `hos.status` and `hos.tripFeasibility` read any operator's duty records by id.**
`server/hosRouter.ts:374–410` — `dutyRecords WHERE operatorId = input.operatorId`, no
`operatorInScope`, no acting-scope resolution. Any caller holding `hos.status` reads any
organisation's driver hours by guessing an integer. *Fix:* `operatorInScope(input.operatorId, await actingScopeFor(ctx.user.id))`
→ NOT_FOUND, the pattern `complianceRouter` already uses. *Verified: reading.*

**H4 — `telematicsRouter` has no tenant boundary at all.**
`server/telematicsRouter.ts` — 7 `roleProcedure`s, **0** uses of any scope helper, imports only
`getDb`. Every read and write is by `unitId`/`faultId`/`eventRef` from input. *Fix:* `unitInScope`
on every unit-keyed procedure; the fault/event ones through the unit they belong to.
*Verified: reading.*

**H5 — `projectRouter` reads and writes money records outside the money boundary.**
`server/projectRouter.ts` — 9 procedures, **0** scope helpers, **0** `moneyScoped` meta; `quotes`
(13 refs), `invoices` (4), `customerAccounts` (3) queried by `input.jobId`. The F1 coverage guard
(`financeScopeCoverage.test.ts`) keys on `financialEntityId`-style input names, and `jobId` is not
one, so the guard does not see this router. *Fix:* resolve the job through `jobInScope`, then
prove the book with `assertCallerOwnsEntity`; add `jobId`-keyed money reads to the guard's
predicate. *Verified: reading.*

**H6 — The production bundle cannot start without devDependencies.**
`dist/index.js` contains static `from "vite"`, `from "@vitejs/plugin-react"`,
`from "@tailwindcss/vite"`; all three are `devDependencies` in `package.json`. The chain is
`index.ts:8 → ./vite → import { createServer } from "vite"` at module top level. A
`pnpm install --prod` deployment throws on the first `import`. *Fix:* dynamic-import the dev
server behind the `isDevelopment` branch so esbuild does not hoist it. *Verified: reading.*

**H7 — Gate 5 is blind to `server/_core/systemRouter.ts`, which is mounted on the app router.**
`routers.ts:352` mounts `system: systemRouter`; the file uses `publicProcedure` and
`adminProcedure`, and lives in `_core/`, outside gate 5's glob. Gate 5 also only greps for
`protectedProcedure` — `publicProcedure` appears 8 times in non-test code and is checked by
nothing. Today's uses look intentional (`system.health`). The gap is that a tenant-data
`publicProcedure` added anywhere under `_core/` would pass every gate. *Fix:* enumerate mounted
routers from `routers.ts` rather than by filename, and classify every procedure kind, not one.
*Verified: reading; lens + 2 refuters.*

### MEDIUM

**M1 — Gate 4's test-file ratchet discards `tsc`'s exit status.**
`TEST_TS_NOW=$(tsc … | grep -cE "\.test\.tsx?\(" || true)`. A `tsc` that cannot run (bad
`tsconfig.tests.json`, OOM) prints no `.test.ts(` lines → count 0 → "clean". *Fix:* `set -o pipefail`
is on but the `|| true` defeats it; capture `tsc`'s status separately and fail on non-zero.
*Verified: reading.*

**M2 — Gates 7b/7c print "the count is pinned" and pin nothing.**
`EXT` and `INB` are computed and echoed; no comparison exists in the script or in any test. What
is enforced — no role procedure in the portal, no role/external in inbound — is real and passes.
*Fix:* either pin the counts or stop saying so. *Verified: reading.*

**M3 — 29 authorisation refusals are asserted with `.rejects.toBeTruthy()`.**
`grep -rn "rejects.toBeTruthy()" server/*.test.ts` → 29. Any rejection satisfies it — wrong
input, NOT_FOUND, database down. In `auditPackage.test.ts:116` the very next line uses
`.toThrow(/release only with…/)` for a different actor, so the stronger form was available.
*Fix:* `.rejects.toThrow(/FORBIDDEN|requires role/)` at each site. *Verified: reading.*

**M4 — Gate 8's generator counts fewer suites than the runner runs.**
`current-state.sh` counts `find server -name '*.test.ts'`; vitest's include also has
`client/src/**/*.dom.test.tsx` (16 files). The document's "test files" row is therefore a
different number from what CI executes. *Fix:* count what `vitest.config` includes.
*Verified: reading; lens + 2 refuters.*

**M5 — Migration register's "current state" is one merge behind.**
`docs/architecture/MIGRATION_COLLISION_REGISTER.md` still names `0194` as `main`'s head and lists
`0195`/`0196`/`0198` as claimed-by-branch; `drizzle/` on `main` holds `0195`, `0196`, `0198`
(#29, #54 merged). *Fix:* update the block; it is the document open branches consult.
*Verified: lens + 2 refuters.*

### LOW

**L1 — No gate detects a duplicate migration prefix.** `0157` is used twice, documented as
historical, non-conflicting (different tables) and order-stable (`LC_ALL=C` and `en_US` agree).
Gate 0 tests only `0016`/`0017`. A future accidental duplicate that *did* conflict would pass.
*Verified: reading. The refuters marked the original wording overstated; the gap stands.*

**L2 — Gate 0a checks the Node version but not `@types/node` against `.nvmrc`**, which is the
drift its own header cites. *Verified: lens + 2 refuters.*

**L3 — Gate 6's skip check is filename-based** (`.db.test.ts`) and so covers 65 of ~156
database-gated suites; a `*.test.ts` that gates on `DATABASE_URL` can skip unseen. Moot until H2
is fixed, then real. *Verified: lens + 2 refuters.*

---

## 3. Refuted on inspection

Listed so the reader knows what was checked and found sound.

- **"Bind failure after the worker starts leaves a headless worker."** `listen.ts` turns the
  bind `error` into a rejection; `await listenOnPort` (`index.ts:73`) precedes the worker-started
  log (76); the catch closes the worker and sets `exitCode = 1`. The header of `listen.ts`
  documents this exact fix. *Refuted: reading.*
- **"Gate 5's glob misses files that mount procedures" — as I first stated it.** My own grep
  matched three lines in `recordsAuthorization.ts` and `voiceTranscription.ts`; all were comments.
  The real gap is H7, which is about *procedure kind*, not filename. *Refuted, then re-found.*
- **"`0157` duplicate breaks the chain."** See L1: registered, non-conflicting, stable.
- **"`testProcedure` is a procedure kind used in production."** It is a mechanic-repair data
  field ("test procedure"), 12 uses in `shopRouter`/`recordsRouter`/`mechanicRelease`. *Refuted: reading.*

---

## 4. Reported by a lens, not yet re-read

Raised by the automated pass; the adversarial re-read had not reached them when this was written.
Each is a lead, not a finding. Severities are the lens's own.

**Runtime.** Workflow rule engine: `workflowRuntime.ts:104` does insert rules, so a writer exists
— whether anything calls it at boot is open (high, if true). Shutdown ends the worker pool with an
event in flight; `lifecycle.stop()` does not await it (medium). `index.ts` SIGTERM handler never
ends the drizzle pool or exits (medium). Webhook retry sweep has no `LIMIT`, no due-time filter,
runs every drain tick (medium; also raised by the wiring lens). Boot never touches the database;
a wrong `DATABASE_URL` surfaces at first request (medium). Worker has no logger; claim failures
and dead letters are silent (medium). Missing `LEASEOS_PORTAL_MFA_KEY` disables all webhook
dispatch with no log line (low).

**Security.** `auth.refresh`/`auth.revokeAll` redeem a family without the `appId` check
`verifySession` makes (medium). `auth.logout` is not origin-guarded though `csrf.ts` scopes the
check to every endpoint that mutates (low). `inbound.ingest` accepts an uncapped `z.record` into
a 64 KiB column (low). `sync.receivePackage.recordUpdates` has no `.max()` while its sibling
`items` is capped at 500 (low).

**Wiring.** `restrictedVaultRouter` opens matters on `incidentReports` fetched by id (medium).
`facilityDirectory.assessLoad` reads loads by id without `requireLoad` (medium). The rules →
tasks chain has no production publisher (medium). `operationalTasks` have no acknowledge/complete
path (medium). Five `*Service*.ts`/backfill modules have zero production importers (low).
`scopeGuard.evaluateClaimedException` has zero callers (low).

**Tests.** Engine reachability census treats `import type` as wiring (medium). A swallowed INSERT
makes a payroll-proposal assertion conditional (medium). `setGeoFetcher`, the real egress edges,
and `storage.ts`'s key refusal are injection-only — the shipped implementation is never executed,
the same pattern that hid the webhook SSRF (medium ×3). `secretBoundary`, `tenantIsolation`,
`authArchitecture`, `knowledgeWritePaths` guards match token text with stated evasions (medium ×4).
Seven guards strip from the first `//` on each line, truncating URLs in strings (low). Six more
low items on fixed-delay drains, shared-outbox windows, and prose-pinning assertions.

**Migrations.** `pnpm db:push` runs drizzle-kit against a journal that stops at `0018` and a
snapshot chain that does not match the SQL — the script would generate against stale state
(medium). *(The gate uses `apply-migrations.sh`, not this; it matters only if someone runs the
package script.)*

---

## 5. Order of work

1. **Restore CI** (§0). Everything below is only as good as the local gate until then, and the
   local gate stops at gate 6 on issue #46 — so today, nothing runs gates 7–8 automatically at all.
2. **H1, refresh cookie path.** It is a one-constant fix with a test that must be rewritten to
   assert the prefix relationship. Until it lands, browser sessions do not rotate.
3. **H3, H4, H5 — the three unscoped routers.** Same shape as F1.1 and F1.2, which the repo
   already knows how to do; ~30 lines each plus the guard-predicate widening for `jobId`.
4. **H2 + M1 + H7 — make the gate honest.** Strip colour before the skip grep; keep `tsc`'s exit
   status; enumerate mounted routers from `routers.ts` and classify every procedure kind. These
   three are why a green gate has meant less than it looked like it meant.
5. **H6, dev-only imports in the prod bundle.** Small, and it decides whether `pnpm start` works
   on a clean host.
6. **Issue #46.** Not a fix to the widget suite's timeout — that hides the 4.5 s — but until it is
   resolved the local gate never reaches gates 7–8, which is the practical cost.
7. **§4**, once the remaining re-reads land; the injection-only trio in the tests lens is the one
   to take first, because it is the exact shape that hid the SSRF vector in #66.
