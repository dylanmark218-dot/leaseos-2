# Audit remediation — 2026-09-21

What the import audit (`audit/github-import-2026-09-21/AUDIT.md`) found, and what
was done about it. Findings that were **not** acted on are listed too, with the
reason, because a remediation note that records only its wins is one you cannot
plan from.

## Fixed

### SEC-1 — `JWT_SECRET` fallback (High)

`assertProductionSecrets()` in `server/_core/env.ts`, called from `startServer()`
before anything binds a port or starts a worker. It refuses to start when
`JWT_SECRET` is unset, when it is under 32 **bytes**, or when `VITE_APP_ID` is
unset. The error names the length and never the value, and reports every problem
at once rather than one per restart. `server/_core/env.test.ts` (9 cases) pins
all of it, including the byte-vs-character measure — verified by reverting to
`.length` and watching that case fail.

**Correction: the threat first stated here was wrong.** The original version of
this note, the code comment, the commit message and PR #1's body all said that
an empty `JWT_SECRET` lets anyone mint a session for any `openId` and that "the
forged session simply works". It does not. Tested against the pinned `jose`
6.1.0, `SignJWT.sign()` with a zero-length key throws
`DOMException: Zero-length key is not supported`. The failure is **closed**: no
session can be minted, `verifySession` rejects everything, and the symptom is a
login loop with a stack trace — not silent forgery.

The guard is still right to exist, for two reasons the original framing
obscured. A **short** secret is the genuinely open failure — it is recoverable
offline from any session token its holder already has, and every session token
is handed to a browser — and that is what the length floor is for. And an empty
one turns a missing environment variable into a confusing runtime outage that a
boot-time refusal names in one line.

The measure is bytes because the two differ for exactly the secrets people use:
a 32-character hex string is 16 bytes, half the entropy the number promises. The
first version counted `String.length`.

**`VITE_APP_ID` is now required too**, which the first version missed and which
made SEC-6 inert — see below.

**The guard now fires whenever the production bundle is served,** not only when
`NODE_ENV === "production"`. `index.ts` chose static assets for anything that is
not `"development"` while `ENV.isProduction` tested for exactly `"production"`,
so a deployment with `NODE_ENV` unset or set to `"staging"` got production
assets with no secret check. Both now read one `isDevelopment` decision.

### SEC-6 — `appId` decoded but never checked (Medium)

`verifySession` compares the token's `appId` against `ENV.appId`
(`server/_core/sdk.ts`). A signing secret shared across deployments — the same
value pasted into staging, or a second app on the same platform — made a session
from either one valid here, because the signature checked out and the claim that
would have distinguished them was decoded and dropped.

**It shipped inert, and SEC-1 is what fixes that.** The comparison is guarded by
`if (ENV.appId && ...)`, and `ENV.appId` reads `VITE_APP_ID`, which nothing
required. Unset, the check never fired and the note above claimed a protection
that was not running. `assertProductionSecrets` now requires it.

Requiring it is safe rather than a new constraint, because it was already
mandatory in fact: `verifySession` refuses a token whose `appId` is not a
non-empty string, and `signSession` fills that claim from `ENV.appId` — so with
it unset the server mints tokens it will itself reject. The only thing that
changed is when you find out.

**Every token creator inside this repository is safe, and it is provable.**
`jose` is imported in exactly one file and `SignJWT` constructed in exactly one
place — `signSession` — whose only caller is `createSessionToken`, whose only
caller is the OAuth callback. That path sets `appId: ENV.appId` and
`verifySession` compares against `ENV.appId`: the same value, same process.

The pre-existing non-empty check bounds the rest, and this is the part that
settles the blast radius. `verifySession` **already** refused a token whose
`appId` was not a non-empty string, before this PR. So any token that has ever
authenticated here was signed with this deployment's `JWT_SECRET` and carried a
non-empty `appId`. And had `VITE_APP_ID` been unset in production,
`createSessionToken` would have minted `appId: ""` and that pre-existing check
would have rejected every session the server issued — login would already have
been wholly broken. It follows that `VITE_APP_ID` is set wherever login works,
and every live cookie already carries exactly the value now compared against.

**Still open, and external:** cron sessions. A `cron_` token reaches the new
check *first* — `authenticateRequest` calls `verifySession` before it inspects
the `cron_` prefix, and the platform's own project validation
(`getUserInfoWithJwt`, which posts `projectId: ENV.appId`) happens downstream,
so it cannot rescue a refusal. Nothing in this repository mints such a token.
See the external deployment prerequisites below.

`server/_core/sessionAppId.test.ts` pins the binding and the ordering.

### DEP-1 — unused AWS SDK in production dependencies (High)

`@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` removed. Nothing in
`server/`, `client/`, `shared/`, `scripts/`, `tools/` or `drizzle/` imported
either; `server/storage.ts` goes through Forge presigned URLs and says why.

They were the **only** path to `fast-xml-parser`, which carried the single
critical advisory in the production tree. That branch is gone.

### DEP-2 — production dependencies behind their security releases (High)

| Package | Was | Now |
|---|---|---|
| `mysql2` | 3.15.1 | 3.24.4 |
| `drizzle-orm` | 0.44.6 | 0.45.2 |
| `axios` | 1.12.2 | 1.20.0 |
| `nanoid` | 5.1.6 | 5.1.16 |
| `@trpc/server` / `client` / `react-query` | 11.6.0 | 11.19.0 |

The three tRPC packages moved together; they share a wire format and splitting
them is how a client and server disagree about it.

Advisory counts across the whole dependency graph: **critical 3 → 2, high 58 → 39,
moderate 81 → 61, low 11 → 8**.

**Corrected 2026-09-21: the claim that followed these numbers was wrong.** The
original text called both remaining criticals "development-chain only" and
concluded "no critical advisory remains in the shipped tree". `vitest` is indeed
test-only — the advisory is in its UI server, which this project never runs.
`tar` is not. `dist/index.js` imports `@tailwindcss/vite` at runtime, which
reaches `@tailwindcss/oxide` and then `tar`, because `server/_core/index.ts`
imports `./vite` unconditionally and that module imports `vite` and
`vite.config` at the top level — an ESM import is evaluated when the module
loads, not when the production branch is skipped.

So one critical advisory does remain reachable from the shipped tree, and the
production server additionally requires five `devDependencies` at runtime. Both
are pre-existing rather than introduced here, and DEP-3 in
`audit/github-import-2026-09-21/AUDIT.md` carries the evidence and why the
obvious repair does not work.

### A type that described nothing (found by the mysql2 bump)

`SqlRunner.execute` in `server/_core/workflowRuntime.ts` took `params?: unknown[]`.
mysql2 3.24 narrowed its own signature, and `mysql.Pool` stopped satisfying that
type — correctly, because the type was never true. `unknown[]` claims any value at
all can be bound, and there is no wire encoding for a function, a symbol or an
arbitrary class instance.

Replaced with an explicit `SqlParam` union. `undefined` is deliberately excluded:
mysql2 **throws** `Bind parameters must not contain undefined. To pass SQL NULL
specify JS null`, so an `undefined` parameter is not a NULL, it is an exception
inside whatever transaction was open. The compiler now enforces the driver's own
rule at every call site — verified by removing a `?? null` and watching `tsc`
reject it.

**What this did not find.** The seven optional columns in the `operationalTasks`
insert now read `?? null`, and that changed no behaviour: `planTasks` in
`workflowEngine.ts` already normalises every one of them to `null` at
construction. The call sites now agree with what the producer was already doing.
`server/_core/workflowRuntimeBindParams.test.ts` pins the invariant at the
consumer and is honest in its own comment that it passes vacuously today — which
is the moment to install it, since the guarantee lives in two files that do not
reference each other and every way to break it looks ordinary in review.

Three test files bound values the narrowing rejected. **The first version of
this note said they were "typed `unknown`", which was true of only one of them**
— the vault fixture. The other 16 sites were precisely typed: probing each
against `never` reports `number | undefined` for the `operationalTruth` ids and
`string | null | undefined` for the gateway's `resultRef`, because the db
helpers open with `if (!db) return undefined` and `integrationRouter`
initialises `resultRef` to `null`.

That distinction matters, because the first repair — `Number(id)` and
`String(r1.resultRef)` — was the wrong shape for a precisely-typed optional.
`Number(undefined)` is `NaN`, which matches no row and surfaces several lines
later as a read of `undefined.status`; `String(null)` is not an absent value at
all but the ordinary five-character string `"null"`, which a `WHERE` clause will
happily look a row up by. Both are now assertions — `rowId()` and `resultRef()`
— that say what the suite relies on and fail on the line relying on it. The
vault fixture drops its cast and non-null assertion: an override set to
`undefined` means leave the column alone, so it is omitted from the statement
rather than bound.

The CI gate's test-file type-error ratchet is at its pinned **0**.

### mysql2 3.22 changed authentication behaviour — an external check before deploying

The advisory that motivated the `mysql2` bump is fixed **by disabling the
plugin**: from 3.22.0 `mysql_clear_password` is off unless
`enableCleartextPlugin` is set, and a server asking for it is a fatal error
rather than a silent downgrade.

**Verdict on whether that breaks this deployment: cannot be determined from this
repository.** Not "probably fine" — unknowable, and recorded as such. The
repository contains no artifact describing the production database: no
Dockerfile, no compose file, no `.env` or `.env.example`, no platform manifest,
no Terraform, no Kubernetes, no deployment document. The only `.github` content
is `ci.yml` and a PR template. No migration or script ever creates a database
account — there is no `CREATE USER`, `GRANT` or `IDENTIFIED WITH` anywhere in
the 169 files under `drizzle/` or in `scripts/`. `caching_sha2_password`,
`authPlugins` and `authSwitchHandler` return zero hits; `ssl` appears nowhere in
`server/`, `client/`, `shared/`, `scripts/`, `drizzle/` or `.github/`. The whole
production database configuration is one runtime variable, `DATABASE_URL`,
supplied by the host.

**CI does not settle this and must not be read as settling it.** It proves that
MariaDB 10.11 with an empty root password works under 3.24.4 — that is a
statement about the CI service's authentication configuration, not about the
production host's.

**Two corrections to the first version of this section, both verified here
rather than taken on trust:**

1. It said this is "a behaviour change this repository cannot opt out of in
   code — `server/db.ts` hands `DATABASE_URL` straight to `drizzle()`, with no
   connection-option seam." Right about the code, **wrong about the seam**.
   mysql2's `ConnectionConfig.parseUrl` copies every URL query parameter into
   the options object, and `enableCleartextPlugin` is a valid one. Verified
   against the installed 3.24.4:

   ```
   mysql://u:p@h:3306/db?enableCleartextPlugin=true  ->  true,  database "db"
   mysql://u:p@h:3306/db                             ->  false, database "db"
   ```

   So the escape hatch exists and is reachable by editing the environment
   variable alone. **With a real caveat, also confirmed by running it:**
   `scripts/ci-gate.sh` and `scripts/apply-migrations.sh` parse `DATABASE_URL`
   by naive shell substring removal, so the query string lands in the database
   *name* — `db="${hostpart#*/}"` yields `leaseos?enableCleartextPlugin=true`.
   The application would connect; the gate and migration scripts would not.

2. **TLS does not fix this,** which is the obvious thing to reach for. mysql2
   treats `mysql_clear_password` as directly usable on a secure connection, but
   then ANDs in `enableCleartextPlugin` regardless, so the client answers the
   handshake with `mysql_native_password`, the server sends an auth switch, and
   the auth-switch gate throws fatally with no secure-connection exception.
   Adding `ssl` will not make a clear-password server work.

**And about this note's own evidence:** `audit/hardening-2026-09-21/vitest.log`
was recorded without `DATABASE_URL`, so every `.db.test.ts` suite shows as
skipped and that run opened no mysql2 connection at all. It proves nothing about
database connectivity. The only place 3.24.4 has spoken to a database is CI.

## Not fixed, and why

### SEC-2 — session JWT mirrored into `sessionStorage` (Medium)

`client/src/main.tsx` reads a `manus-cookie` value out of `sessionStorage` and
forwards the session as `Authorization: Bearer`; `server/_core/sdk.ts` accepts that
header in every environment. It gives away the `httpOnly` cookie's protection: any
XSS reads a valid session token directly.

The obvious fix is to gate it on a development build. It is **not applied** because
the comment says it exists for browsers that block iframe cookies — Safari ITP,
private browsing, WebView — and those are production-built preview sessions, not
development ones. Gating on `import.meta.env.DEV` would fix the exposure by
breaking the preview login it was written for, and which of those matters is a
call about how this is deployed, not one to infer from the code.

**What it needs:** a decision on whether the preview path is still in use. If it
is, an explicit opt-in flag rather than an unconditional fallback; if it is not,
delete both halves.

### SEC-3 — one-year sessions, no server-side revocation (Medium)

`ONE_YEAR_MS` in `server/_core/sdk.ts`, verified by signature alone — no session
table, so logout cannot invalidate a token and a leaked one stays valid until it
expires. Shortening the lifetime is a product decision with a visible cost (users
signed out more often) and the real repair is a revocation path, which is a
feature rather than a patch.

### SEC-4 / SEC-5 — `sameSite: "none"`, no security headers, no rate limiting

`helmet`'s default CSP would need a policy written against what this app actually
loads, and a wrong one breaks the page rather than failing safe. A rate limiter
needs limits chosen per route — the portal already locks an identity after 5
failures, so the gap is request volume and body size, where a guessed number
either does nothing or throttles a legitimate field device.

Both are worth doing and neither is a one-line change.

### Express 4 (`path-to-regexp`, `qs`, `body-parser`)

These arrive through Express 4.21.2, the last 4.x release; the fixes are in
Express 5. That is a framework migration with its own test pass, not a
dependency bump.

**Corrected: they are not the only ones left.** The original text said "the
remaining shipped advisories all arrive through Express 4.21.2". Also shipped
are `lodash` via `recharts`, and `dompurify` and `mermaid` via `streamdown` —
all production dependencies. And `tar`, reached at runtime through the
`@tailwindcss/vite` import that `dist/index.js` carries; see DEP-3 in the import
audit for why the production bundle imports five devDependencies.

### The `tailwindcss>nanoid` override

`package.json` pins `tailwindcss>nanoid` to `3.3.7`, and the build chain resolves
`nanoid` 3.3.11 regardless — the override matches no path in the current tree.
Raising it was tried and changed nothing, so it was reverted rather than left as a
confident-looking no-op. The 3.x copies come from postcss/tailwind at build time
and are not in the shipped bundle.

### Also corrected

- **`template.json`** embeds a full copy of `package.json` for scaffolding and
  was not updated by the dependency work, so it still offered the two AWS SDK
  packages and every pre-bump version. Synced.
- **`registerClaims.test.ts`** matched only `**DONE` and `**PARTLY DONE`, which
  left 24 of the register's 66 status rows invisible to all three existence
  checks — a fake migration number or unresolvable commit in a `DECIDED AND
  DONE`, `PARTIAL`, `CORE BUILT` or `STAGED` row passed silently. The row filter
  is now derived from `STATUS_VOCABULARY` so a new status word cannot add a
  blind spot with it. The pre-import whitelist drops to the **four** hashes the
  guard actually reaches; `8a03803` and `d6a3433` appear only in prose, and
  whitelisting a token no check sees suggests it was examined and excused. Two
  cases added: the set's size is pinned, and an unresolvable hash in a synthetic
  claiming row is shown to still fail — the latter because this note's first
  version asserted that behaviour without running it.
- **Three scratch files** (`__probe2.ts`, `__probe_types.ts`,
  `drizzle.probe.config.ts`) were committed and pushed by a `git add -A` issued
  while review agents were writing in the same working tree, along with one
  agent's half-finished edit to a test. Removed.

## External deployment prerequisites

Neither can be settled from this repository, and neither is invented here. Both
need a person with access to the real deployment. They are listed separately
from the fixes above because they are not work that was done — they are work
that remains, outside this tree.

1. **The database account's authentication plugin.**

   ```sql
   SELECT user, host, plugin FROM mysql.user WHERE user = '<the DATABASE_URL user>';
   ```

   `mysql_native_password`, `caching_sha2_password` or `ed25519` — safe, nothing
   to do. `mysql_clear_password`, `auth_pam`, `pam` or any PAM/LDAP plugin —
   **unsafe**: connections will fail after this upgrade, and the repair is to
   change the account's auth plugin, not to re-enable cleartext.

2. **The cron token's `appId` claim.** When the platform scheduler invokes this
   project's cron callback, is the `appId` in that JWT the same string injected
   into the runtime as `VITE_APP_ID`, or a platform-internal identifier — a task
   id, a tenant id, or another form of the project's identity? And is it stable
   when a project is renamed, cloned to staging, or moved between tenants? If it
   differs, scheduled tasks will fail authentication after this deploy.

3. **Secondary, and pre-existing rather than caused by this work:** does the cron
   token carry a non-empty `name` claim? `verifySession` has always required one
   and rejects before the cron branch is reached. `buildCronUser` defaults the
   display name, but that default applies to the platform's *response*, not to
   the token claim. Same class of unknown, worth confirming in the same
   conversation.

## Verification

`tsc --noEmit` clean; test-file ratchet 0 against a pinned ceiling of 0; 0 bare
`protectedProcedure`; portal mounts 0 `roleProcedure`; `inboundRouter` mounts 0
role or external procedures (2 `integrationProcedure`); reserved migration slots
0016/0017 free; `LEASEOS_CURRENT_STATE.md` regenerates identically; production
build succeeds; 3,276 tests pass.

### Gate 8 caught this change, and it was right to

The first push of this branch failed CI at **gate 8 — "Current-state document is
generated, not claimed."** Adding `workflowRuntimeBindParams.test.ts` moved the
test counts, and `LEASEOS_CURRENT_STATE.md` still read `290 / 3938` against a
regenerated `291 / 3941`.

The document is regenerated with `scripts/current-state.sh` rather than hand-
edited, which is the whole point of that gate: a figure typed into a document is
a claim, and the same figure produced by a script is a measurement.

The reason it was not caught before pushing is worth stating. The local gate run
was assembled by reading `scripts/ci-gate.sh`, and the reader stopped at the
`Summary` header, taking it for the end — gates 7c and 8 sit after it. So the
local run was not the gate; it was a subset that looked like the gate. Both are
now run, and the table in `audit/github-import-2026-09-21/AUDIT.md` has been
corrected to list all twelve rows — nine numbered gates and three lettered sub-gates.

The 14 failures in `server/fieldroute.test.ts` are the database-dependent ones
described in the import audit (TEST-1) and are unchanged by this work. The clean
database, migration and table-parity gates need MariaDB and run in CI.
