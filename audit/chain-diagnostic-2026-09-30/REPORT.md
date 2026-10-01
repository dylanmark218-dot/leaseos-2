# Chain diagnostic — 2026-09-30 — FROZEN

**Status of this document: frozen.** Every item below is exactly one of **CONFIRMED**, **REFUTED**,
**UNRESOLVED**, or **LEAD / NOT YET VERIFIED**. A CONFIRMED item has direct source evidence read
from `main` at `4a7ffa7797767d7d6d600242d5726dcfc070c1ee` and, where practical, an executable
reproduction that is quoted. No item is CONFIRMED because an agent said so.

**Provenance.** A first pass ran six read-only lenses with two adversarial refuters per finding
(workflow `wf_bfece862-a4f`). It was **terminated** at 53 of ~114 agents so that this freeze
would rest on direct re-reading rather than on a queue; the 43 verdicts that had landed are kept
at `agent_verdicts_at_termination.json` beside this file, and none of them was found to disagree
with the direct evidence. The earlier, unfrozen draft of this report (`f26cc8c`) is superseded.

---

## Closure — 2026-10-01: verification-floor incident CLOSED

The findings below stay frozen as written; this note records how the incident ended.

| | |
|---|---|
| Actions cause | **RESOLVED, outside the repository**: the account's Actions spending limit. Reset by the owner on 2026-09-30; the next re-run was assigned a runner. Ten attempts before the reset had failed in 2–13 s with `runner_id: 0`; none after it did. |
| First real-execution run | run 513 attempt 8 on `eb684f8` (job 110147989149, runner `GitHub Actions 1000002187`): checkout, service, install, **CI gate 8 m 10 s**, success. |
| #68 (this report) | merged `a413123`; its run 511 attempt 4 green (runner 1000002188, gate 8 m 3 s). |
| #69 (verification floor) | merged `a89607f`; run 513 attempt 8 green as above. |
| Integrated `main` | `a89607f`, run 515 (job 110151236092, runner 1000002191, gate 7 m 26 s): **success**. Gates 4, 5, 6, 8 and the #46 harness query are on `main`. |
| Merge authorisation | **Restored.** A green remote run with a real runner is again the condition, and it is again met. |

Next: §3 items 3–6, beginning with P0-A1 (HOS tenant isolation), each its own PR.

---

## 0. GitHub Actions — CONFIRMED outage; cause RESOLVED (see Closure above) and outside the repository

| Evidence | Value |
|---|---|
| Last real `CI` run on `main` | run 475, `e08a135`, 2026-09-25 15:01, **success**, 5 m |
| Every `CI` run since (477–503), all branches | `failure` in 3–5 s, `runner_id: 0`, no steps, no logs (API 404) |
| Re-run of run 475 itself, 2026-09-25 16:48 | **failure in 3 s** — same commit that passed at 15:01 |
| `.github/workflows/ci.yml` | byte-identical to run 475's (`git diff e08a135 main -- .github/` empty) |
| Conclusion is `failure`, not `cancelled` | rules out the concurrency group |
| Dependabot's separate workflow, 2026-09-28 | success, 12 m — Actions is not globally off |
| Repository visibility | **private** (Actions minutes quota applies) |
| Usage API on the 496 s run 476 | `billable.UBUNTU.total_ms: 0` — this token cannot see the quota state |

Ruled out **inside** the repository: workflow defect (unchanged file), concurrency/cancellation
(`failure`), permissions (unchanged `permissions: contents: read`). What remains is account-side:
Actions minutes quota or spending limit on a private repository, a runner-policy restriction, or
a GitHub incident. The quota reading fits every observation (~480 runs × ~7 min in September on a
private repo) and makes one testable prediction: **if the quota is the cause, `CI` resumes on
2026-10-01 with no repository change.** Whoever holds admin should read *Settings → Billing and
plans → Actions* and *Settings → Actions → General*.

**Consequence: 30 commits merged to `main` between `6b31d58` and `4a7ffa7` with no CI.** §1 is
their only verification. **Merge authorisation for anything is suspended until remote CI executes
real runner steps and returns green** — a local green is no longer sufficient.

---

## 1. The chain, and what it says on `4a7ffa7`

| Gate | Enforces | Result, local, empty database |
|---|---|---|
| 0a | `check-version-truth.mjs`: `.nvmrc` vs everything else | ✅ |
| 0 | slots `0016`/`0017` empty | ✅ |
| 1 | drop/create `<db>` and `<db>_widgets` | ✅ |
| 2 | `apply-migrations.sh`, `ls | sort` order, 181 files | ✅ |
| 3 | `verify-parity.sh` | ✅ |
| 4 | `tsc --noEmit`; test-file errors ≤ pinned **0** | ✅ 0 / 0 |
| 5 | no `\w+: protectedProcedure` in `server/*Router*.ts`, `routers.ts`, `recordsRouter.ts` | ✅ 0 |
| 6 | vitest; no `.db.test.ts` reporting `↓` | 394 files, **5 955 passed**, 3 skipped, **1 failed** (§2 K) |
| 7 | `pnpm build` | ✅ `index.js` 3.3 MB, `worker.js` 468 KB |
| 7b / 7c | portal only `externalProcedure`; inbound only `integrationProcedure` | ✅ 36 / 2, 0 wrong-kind |
| 8 | current-state document byte-identical to regeneration | ✅ |

Because `set -e` stops the script at gate 6 on item K, **gates 7–8 had never run locally** until
this diagnostic ran them by hand; remote CI was the only thing that exercised them, and remote CI
has been dead since 25 Sep.

Runtime chain: `index.ts` → `env.ts` → express → `/api/trpc` (`index.ts:44`) → `routers.ts`
(`appRouter`) → handler → service → `db.ts` → MariaDB; tenant boundary via `actingScopeFor` /
`resolveActingScope` / `financeScopeFor` / `assertCallerOwnsEntity` / `ownershipScopeWhere`;
`listen.ts` binds after env, worker starts after bind; `worker.ts` drains the outbox, runs the
webhook retry sweep through `egressPost`, then purges.

---

## 2. Findings — frozen

### The twelve reconciled claims

| # | Claim | Status | Evidence |
|---|---|---|---|
| **A** | Refresh cookie path `/api/auth` vs endpoint `/api/trpc/auth.refresh` | **CONFIRMED** | `cookies.ts:10` `REFRESH_COOKIE_PATH = "/api/auth"`; `cookies.ts:33` applies it; tRPC mounted at `/api/trpc` (`index.ts:45`); **0** non-test routes under `/api/auth`; client `sessionRefresh.ts:136` calls `/api/trpc/auth.refresh`; RFC 6265 path-match requires the cookie path to be a prefix of the request path, and it is not. `sessionCookiePolicy.test.ts:55–56` and `auth.logout.test.ts:61` **pin** `/api/auth`. |
| **B** | Gate 6 skip detection under `CI=true` / ANSI | **CONFIRMED, reproduced** | `env -u DATABASE_URL CI=true GITHUB_ACTIONS=true npx vitest run server/academyTdgWiring.db.test.ts --reporter=basic` → raw `↓` line present (1), gate regex `^ *↓ .*\.db\.test\.ts` matches **0**; same output with ANSI stripped matches **1**; same run without `CI` matches **1**. The line is `\e[2m\e[90m↓\e[39m\e[22m server/…`. The check has never been able to fire in Actions. |
| **C** | `hosRouter` tenant isolation | **CONFIRMED** | `hos.status` and `hos.tripFeasibility` both: `dutyRecords WHERE operatorId = input.operatorId` (lines 374–410), no `operatorInScope`, no acting-scope call in either handler. |
| **D** | `telematicsRouter` tenant isolation | **CONFIRMED** | 7 `roleProcedure`s; **0** scope-helper uses; imports only `getDb`. |
| **E** | `projectRouter` quote/invoice isolation | **CONFIRMED** | 9 procedures, **0** scope helpers, **0** `moneyScoped`; `quoteByRef`/`accountByRef` (lines 20–21) and `quotes WHERE jobId = input.jobId` (156) with no boundary. The F1 guard's `MONEY_KEYS` (`financeScopeCoverage.test.ts:36`) does not contain `jobId`, `quoteRef` or `accountRef`, and `project.*` is not in its exemption list, so the guard cannot see this router. |
| **F** | Production bundle statically imports dev-only packages | **CONFIRMED** (static) | `dist/index.js` built from `4a7ffa7`: `from "vite"` ×2, `from "@vitejs/plugin-react"`, `from "@tailwindcss/vite"`, `from "vite-plugin-manus-runtime"`. All in `devDependencies`, none in `dependencies`. Chain: `index.ts:8 → ./vite`, `vite.ts:6 import { createServer } from "vite"` at top level. *The boot-without-devDependencies reproduction is P0-C's fixture; a static ESM import of an absent package fails at module load by construction.* |
| **G** | Gate 5 misses `_core/systemRouter.ts` | **CONFIRMED** | `ci-gate.sh:88` glob is `server/*Router*.ts server/routers.ts server/recordsRouter.ts` → `systemRouter` **not in glob**; `routers.ts:36,352` imports and mounts it. |
| **H** | Gate 5 treatment of `publicProcedure` | **CONFIRMED** | `ci-gate.sh:89` greps only `protectedProcedure`; `publicProcedure` occurs **0** times in the gate. Non-test uses: `publicProcedure` 8, `adminProcedure` 7 (`systemRouter.ts:6,16`, `recordsRouter.ts` ×3, `platformAuthority.ts`, `routers.ts` ×5). Today's uses are intentional; the gap is that a tenant-data `publicProcedure` anywhere passes every gate. |
| **I** | Gate 4 can silently lose a `tsc` failure | **CONFIRMED, reproduced** | `ci-gate.sh:78`: `TEST_TS_NOW=$(tsc … \| grep -cE "\.test\.tsx?\(" \|\| true)`. Reproduction: same pipeline with `-p tsconfig.does-not-exist.json` → `count=0` → gate prints "clean"; `tsc` alone exits **1**. The `\|\| true` discards the exit status `pipefail` would have carried. Also: `tsconfig.tests.json` includes `server/**`, `shared/**`, `client/src/**`, so a non-test type error under it exits 2 with count 0 and is likewise lost. |
| **J** | Gate 8 omits DOM/browser test coverage | **CONFIRMED, reproduced** | `current-state.sh:43` counts `find server -name '*.test.ts'` → **378**; `vitest.config.ts:19` includes `client/src/**/*.dom.test.tsx` (**16** files); gate 6 ran **394**; `npx vitest list --filesOnly` → **394**. The document says 378. Absent class: `*.dom.test.tsx` under `client/src` (jsdom). No browser E2E exists; none is claimed. |
| **K** | Issue #46 / `widgetPersistence.db.test.ts` | **CONFIRMED — in-repo harness defect, root cause found** | In isolation on a fresh database, `4a7ffa7` fails `creates the cascade and the per-owner uniqueness` **3/3** (tests phase 15.7–16.7 s); `e08a135`, `6b31d58`, `3127f11` fail it too (6.7–7.8 s) with the test file and imports identical. Process list during the test: `SELECT DELETE_RULE FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_NAME='widgetLayoutItems_layout_fk'` in state **"Opening tables" for 6+ s**. It has **no `CONSTRAINT_SCHEMA` filter**, so MariaDB opens every table in every schema: this server holds **120 `leaseos_*` schemas, 21 583 tables**. Timed: unscoped **7 558 ms, 120 rows** (one per schema — so `fks[0]` asserts an arbitrary schema's rule); scoped to `CONSTRAINT_SCHEMA` **13 ms, 1 row**. Raw DDL is fast (5× create+drop: 74 ms). The 4.2–4.9 s in #46 was this server with few schemas; the "2× slowdown between commits" was schema accumulation between runs, not code. **Category: test query unscoped (repo) × schema count (machine).** The timeout is not the defect and must not be raised. |
| **L** | Current Actions state | **CONFIRMED outage; cause UNRESOLVED (external)** | §0. |

### Other items from the first pass

| Item | Status | Evidence |
|---|---|---|
| 7b/7c say "the count is pinned" and pin nothing | **CONFIRMED** | `ci-gate.sh:124–129`: `EXT`/`INB` echoed, never compared; no test pins them. The enforced property (no wrong-kind procedure) is real. |
| 29 refusals asserted with `.rejects.toBeTruthy()` | **CONFIRMED** | `grep -rn "rejects.toBeTruthy()" server/*.test.ts` → 29; `auditPackage.test.ts:116` then uses `.toThrow(/…/)` on the next line. Any rejection satisfies it. |
| Migration register one merge behind | **CONFIRMED** | Register line 27 names head `0194` and lists `0195`/`0196`/`0198` as branch-claimed; all four exist in `drizzle/` on `main`. |
| Gate 0a does not compare `@types/node` | **CONFIRMED (low)** | `check-version-truth.mjs` reads `.nvmrc` (line 47); `types/node` appears only in comments (lines 7, 14, 21). Currently aligned (`22` / `^22`). |
| Gate 6 skip check is filename-scoped | **CONFIRMED (low)** | 63 `DATABASE_URL`-gated suites named `*.db.test.ts`; **91** gated the same way and not so named. Moot until B is fixed; real after. |
| No general duplicate-migration check | **CONFIRMED (low)** | Gate 0 tests `0016`/`0017` only. `0157` ×2 is registered, non-conflicting, order-stable under `LC_ALL=C` and `en_US`. |

### REFUTED

| Claim | Why |
|---|---|
| Bind failure after worker start leaves a headless worker | `listen.ts` converts the bind `error` into a rejection; `await listenOnPort` (`index.ts:73`) precedes the worker-started log (76); catch closes the worker and sets `exitCode = 1`. |
| Gate 5's glob misses files that mount procedures — *as first stated by me* | The three extra grep hits were comments. The real gap is G/H (file *and* kind). |
| `0157` duplicate breaks the chain | Registered, different tables, stable order. |
| `testProcedure` is a procedure kind used in production | A mechanic-repair data field, 12 uses. |
| `pnpm db:push` matters to the gate | The gate uses `apply-migrations.sh`; `db:push` is an unused package script. *(Downgraded from the first pass's medium; a lead only if someone runs it.)* |

### LEAD / NOT YET VERIFIED

Raised by a lens; no one has re-read them. Leads, not findings.

*Runtime:* rule seeds bootstrapped at boot? (`workflowRuntime.ts:104` writes rules; caller unknown) · shutdown vs in-flight event · SIGTERM never ends drizzle pool · webhook retry sweep unbounded / unindexed · boot never touches the DB · worker has no logger · missing `LEASEOS_PORTAL_MFA_KEY` silently disables dispatch.
*Security:* `auth.refresh`/`revokeAll` skip `appId` · `auth.logout` not origin-guarded · `inbound.ingest` uncapped record · `recordUpdates` no `.max()`.
*Wiring:* `restrictedVaultRouter` by id · `facilityDirectory.assessLoad` without `requireLoad` · rules→tasks has no publisher · `operationalTasks` no complete path · five importerless modules · `scopeGuard.evaluateClaimedException` no callers.
*Tests:* `import type` counted as wiring · swallowed INSERT in payroll test · `setGeoFetcher`, egress edges, `storage.ts` injection-only · four text-matching guards with stated evasions · seven guards truncate at `//` · six low assertion-shape items.

---

## 3. Order of work

1. **Restore remote CI** (§0). Suspend merges until it executes real steps and returns green.
2. **Verification floor** — B, G/H, I, J, K: make the gate able to judge what comes next.
   Gate-only changes; no application behaviour.
3. **P0-A tenant isolation** — C, D, E, each its own PR with adversarial cross-tenant tests.
4. **P0-B session refresh** — A: fix the cookie/endpoint contract, rewrite the pinning tests to
   assert the prefix relationship, prove 15-minute rotation without re-login.
5. **P0-C production-only boot** — F: install prod deps only, boot `dist/index.js`, keep it as a
   release smoke test.
6. Leads in §2, once re-read; the injection-only trio first — it is the shape that hid #66.
